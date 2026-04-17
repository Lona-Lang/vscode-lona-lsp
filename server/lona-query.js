"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
  COMPLETION_ITEM_KIND,
  getReferenceContext,
  getCompletionContext,
  getSignatureContext,
  normalizeTypeText,
  positionToOffset,
  resolveImportPath
} = require("./lona-index");
const { buildModuleRoots, normalizePath, unique } = require("./module-roots");
const QUERY_WARNING_MS = 3000;

const BUILTIN_MEMBER_TABLE = [
  {
    match(typeText) {
      return normalizeTypeText(typeText) === "f32";
    },
    members: [],
    methods: [
      {
        label: "tobits",
        kind: COMPLETION_ITEM_KIND.METHOD,
        detail: "builtin method -> u8[4]"
      }
    ]
  },
  {
    match(typeText) {
      return normalizeTypeText(typeText) === "u8[4]";
    },
    members: [],
    methods: [
      {
        label: "tof32",
        kind: COMPLETION_ITEM_KIND.METHOD,
        detail: "builtin method -> f32"
      }
    ]
  }
];

function writeQueryLog(level, scope, message) {
  const rendered = message instanceof Error
    ? (message.stack || message.message || String(message))
    : String(message);
  try {
    for (const line of rendered.split(/\r?\n/)) {
      process.stderr.write(`[lona-lsp][${level}][${scope}] ${line}\n`);
    }
  } catch {
    // Ignore logging failures.
  }
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function documentMatchesDisk(document) {
  if (!document.filePath) {
    return false;
  }
  const currentText = readFileIfExists(document.filePath);
  return currentText !== null && currentText === document.text;
}

function canonicalModuleName(filePath, rootPaths) {
  const normalizedFilePath = normalizePath(filePath);
  if (!normalizedFilePath || !normalizedFilePath.endsWith(".lo")) {
    return null;
  }

  const matches = [];
  for (const rootPath of unique(rootPaths || [])) {
    const relative = path.relative(rootPath, normalizedFilePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    matches.push(relative.replace(/\\/g, "/").replace(/\.lo$/, ""));
  }

  const canonicalMatches = Array.from(new Set(matches.filter(Boolean)));
  return canonicalMatches.length === 1 ? canonicalMatches[0] : null;
}

function resolveQueryContext(document, settings) {
  if (!document || !document.filePath) {
    return null;
  }

  const rootPaths = buildModuleRoots(document, settings);
  if (!rootPaths.length) {
    return null;
  }

  const activeFilePath = normalizePath(document.filePath);
  const activeModule = canonicalModuleName(activeFilePath, rootPaths);
  if (!activeModule) {
    return null;
  }

  return {
    rootPaths,
    activeFilePath,
    activeModule,
    entryFilePath: activeFilePath,
    entryModule: activeModule
  };
}

function canUseQueryBackend(document, settings) {
  if (settings.preferQueryBackend === false) {
    return false;
  }
  return Boolean(resolveQueryContext(document, settings)) && documentMatchesDisk(document);
}

function makeSessionKey(context, settings) {
  return [
    settings.queryPath || "lona-query",
    context.rootPaths.join("|")
  ].join("::");
}

class QuerySession {
  constructor(context, settings, onClose) {
    this.rootPaths = context.rootPaths;
    this.binary = settings.queryPath || "lona-query";
    this.onClose = onClose;
    this.scope = `query:${makeSessionKey(context, settings)}`;
    this.processHandle = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.currentRequest = null;
    this.queue = Promise.resolve();
    this.closed = false;
    this.currentModule = null;
    this.currentLine = null;
    this.dirtyModules = new Set();
  }

  async run(query) {
    const targetModule = query.module || this.currentModule;
    const commandList = Array.isArray(query.commands) ? query.commands.join(" | ") : "";
    const startedAt = Date.now();
    const warningTimer = setTimeout(() => {
      writeQueryLog("warn", this.scope, `still running after ${QUERY_WARNING_MS}ms module=${targetModule || "-"} line=${typeof query.line === "number" ? query.line : "-"} commands=${commandList}`);
    }, QUERY_WARNING_MS);
    if (typeof warningTimer.unref === "function") {
      warningTimer.unref();
    }
    writeQueryLog("trace", this.scope, `run module=${targetModule || "-"} line=${typeof query.line === "number" ? query.line : "-"} commands=${commandList}`);
    const task = async () => {
      if (!targetModule) {
        throw new Error("lona-query request is missing an active module");
      }
      await this.ensureStarted();
      await this.prepare(targetModule, query.line);
      return this.sendCommandsRaw(query.commands || []);
    };
    const promise = this.queue.then(task, task);
    this.queue = promise.catch(() => {});
    return promise.then((result) => {
      clearTimeout(warningTimer);
      writeQueryLog("trace", this.scope, `done in ${Date.now() - startedAt}ms replies=${Array.isArray(result) ? result.length : 0}`);
      return result;
    }, (error) => {
      clearTimeout(warningTimer);
      writeQueryLog("error", this.scope, error);
      throw error;
    });
  }

  markDirty(moduleName) {
    if (moduleName) {
      this.dirtyModules.add(moduleName);
    }
  }

  async ensureStarted() {
    if (this.processHandle && !this.processHandle.killed) {
      return;
    }
    writeQueryLog("info", this.scope, `spawn ${this.binary} roots=${this.rootPaths.join(",")}`);
    await new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["--format", "json", ...this.rootPaths], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let settled = false;
      const cleanup = () => {
        child.off("spawn", handleSpawn);
        child.off("error", handleError);
      };
      const handleSpawn = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.processHandle = child;
        this.stdoutBuffer = "";
        this.stderrBuffer = "";
        this.currentModule = null;
        this.currentLine = null;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this.handleStdout(chunk));
        child.stderr.on("data", (chunk) => {
          this.stderrBuffer += chunk;
        });
        child.on("exit", (code, signal) => this.handleExit(code, signal));
        child.on("error", (error) => this.handleProcessError(error));
        writeQueryLog("info", this.scope, `spawned pid=${child.pid || "unknown"}`);
        resolve();
      };
      const handleError = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      child.once("spawn", handleSpawn);
      child.once("error", handleError);
    });
  }

  async prepare(targetModule, line) {
    const commands = [];
    const nextState = {
      currentModule: this.currentModule,
      currentLine: this.currentLine,
      dirtyModules: new Set(this.dirtyModules)
    };

    if (nextState.dirtyModules.size > 0) {
      for (const moduleName of Array.from(nextState.dirtyModules).sort()) {
        commands.push(`reload ${moduleName}`);
      }
      nextState.dirtyModules.clear();
      nextState.currentModule = null;
      nextState.currentLine = null;
    }

    const moduleToOpen = targetModule || nextState.currentModule;
    if (moduleToOpen && nextState.currentModule !== moduleToOpen) {
      commands.push(`open ${moduleToOpen}`);
      nextState.currentModule = moduleToOpen;
      nextState.currentLine = null;
    }

    if (typeof line === "number" && nextState.currentLine !== line) {
      commands.push(`goto ${line}`);
      nextState.currentLine = line;
    }

    if (!commands.length) {
      return;
    }

    writeQueryLog("trace", this.scope, `prepare ${commands.join(" | ")}`);
    await this.sendCommandsRaw(commands);
    this.currentModule = nextState.currentModule;
    this.currentLine = nextState.currentLine;
    this.dirtyModules = nextState.dirtyModules;
  }

  sendCommandsRaw(commands) {
    if (!this.processHandle || this.processHandle.killed) {
      return Promise.reject(new Error("lona-query session is not running"));
    }
    if (!Array.isArray(commands) || commands.length === 0) {
      return Promise.resolve([]);
    }
    if (this.currentRequest) {
      return Promise.reject(new Error("lona-query session received overlapping requests"));
    }

    return new Promise((resolve, reject) => {
      this.currentRequest = {
        expected: commands.length,
        replies: [],
        resolve,
        reject
      };
      try {
        writeQueryLog("trace", this.scope, `send ${commands.join(" | ")}`);
        this.processHandle.stdin.write(`${commands.join("\n")}\n`, "utf8");
      } catch (error) {
        const request = this.currentRequest;
        this.currentRequest = null;
        request.reject(error);
      }
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const reply = JSON.parse(line);
      if (!this.currentRequest) {
        continue;
      }
      this.currentRequest.replies.push(reply);
      if (this.currentRequest.replies.length >= this.currentRequest.expected) {
        const request = this.currentRequest;
        this.currentRequest = null;
        request.resolve(request.replies);
      }
    }
  }

  handleExit(code, signal) {
    const stderr = this.stderrBuffer.trim();
    const reason = stderr || `lona-query exited (code=${code}, signal=${signal || "none"})`;
    writeQueryLog(code === 0 ? "info" : "warn", this.scope, `exit ${reason}`);
    this.processHandle = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    if (this.currentRequest) {
      const request = this.currentRequest;
      this.currentRequest = null;
      request.reject(new Error(reason));
    }
    if (this.onClose) {
      this.onClose(this);
    }
  }

  handleProcessError(error) {
    writeQueryLog("error", this.scope, error);
    if (this.currentRequest) {
      const request = this.currentRequest;
      this.currentRequest = null;
      request.reject(error);
    }
  }

  close() {
    this.closed = true;
    if (!this.processHandle || this.processHandle.killed) {
      return;
    }
    writeQueryLog("trace", this.scope, "close session");
    try {
      this.processHandle.stdin.write("quit\n", "utf8");
    } catch {
      // Ignore stdin failures during shutdown.
    }
    this.processHandle.kill();
  }
}

const querySessions = new Map();

function getQuerySession(context, settings) {
  const sessionKey = makeSessionKey(context, settings);
  if (!querySessions.has(sessionKey)) {
    querySessions.set(
      sessionKey,
      new QuerySession(context, settings, () => {
        if (querySessions.get(sessionKey)) {
          querySessions.delete(sessionKey);
        }
      })
    );
  }
  return querySessions.get(sessionKey);
}

async function runQueryCommands(context, settings, query) {
  return getQuerySession(context, settings).run(query);
}

function markQuerySessionDirty(target, settings) {
  const document = typeof target === "string" ? { filePath: target } : target;
  const context = resolveQueryContext(document, settings);
  if (!context) {
    return;
  }
  const session = querySessions.get(makeSessionKey(context, settings));
  if (session) {
    writeQueryLog("trace", session.scope, `mark dirty ${context.activeModule}`);
    session.markDirty(context.activeModule);
  }
}

function closeAllQuerySessions() {
  writeQueryLog("trace", "query", `close all sessions count=${querySessions.size}`);
  for (const session of querySessions.values()) {
    session.close();
  }
  querySessions.clear();
}

function getActiveQuerySessionCount() {
  return querySessions.size;
}

function replyByCommand(replies, command) {
  return replies.find((reply) => reply.command === command) || null;
}

function diagnosticsFromQueryReply(reply) {
  if (!reply || !reply.ok) {
    return [];
  }
  const items = reply.result && Array.isArray(reply.result.items) ? reply.result.items : [];
  return items.map((item) => {
    const line = item.location ? Math.max(0, item.location.line - 1) : 0;
    const character = item.location ? Math.max(0, item.location.column - 1) : 0;
    const hint = item.hint ? `\n${item.hint}` : "";
    return {
      path: item.location && item.location.path ? normalizePath(item.location.path) : null,
      range: {
        start: { line, character },
        end: { line, character: character + 1 }
      },
      severity: 1,
      source: "lona-query",
      message: `${item.message}${hint}`
    };
  });
}

function keywordItems() {
  return [
    "import",
    "struct",
    "trait",
    "impl",
    "global",
    "def",
    "set",
    "var",
    "const",
    "ref",
    "if",
    "else",
    "for",
    "ret",
    "break",
    "continue",
    "cast",
    "true",
    "false",
    "null"
  ].map((label) => ({
    label,
    kind: COMPLETION_ITEM_KIND.KEYWORD,
    detail: "keyword"
  }));
}

function addCompletion(targetMap, item) {
  const key = `${item.kind}:${item.label}`;
  if (!targetMap.has(key)) {
    targetMap.set(key, item);
  }
}

function normalizeQueryGlobalKind(kind) {
  if (kind === "struct") {
    return "type";
  }
  return kind;
}

function mapQueryKindToCompletionKind(kind) {
  switch (normalizeQueryGlobalKind(kind)) {
    case "method":
      return COMPLETION_ITEM_KIND.METHOD;
    case "func":
      return COMPLETION_ITEM_KIND.FUNCTION;
    case "local":
    case "self":
    case "global":
      return COMPLETION_ITEM_KIND.VARIABLE;
    case "import":
      return COMPLETION_ITEM_KIND.MODULE;
    case "field":
      return COMPLETION_ITEM_KIND.PROPERTY;
    case "type":
    case "trait":
      return COMPLETION_ITEM_KIND.STRUCT;
    default:
      return COMPLETION_ITEM_KIND.VARIABLE;
  }
}

function makeGlobalCompletionItem(item) {
  const normalizedKind = normalizeQueryGlobalKind(item.kind);
  if (normalizedKind === "field") {
    return null;
  }
  return {
    label: item.name,
    kind: mapQueryKindToCompletionKind(normalizedKind),
    detail: item.detail || normalizedKind
  };
}

function makeLocalCompletionItem(item) {
  return {
    label: item.name,
    kind: mapQueryKindToCompletionKind(item.kind),
    detail: item.type || item.detail || item.kind
  };
}

function parseReturnType(signature) {
  if (!signature) {
    return null;
  }
  const match = signature.match(/->\s*(.+)$/);
  return match ? normalizeTypeText(match[1]) : null;
}

function splitTupleTypes(typeText) {
  const trimmed = normalizeTypeText(typeText);
  if (!trimmed || !trimmed.startsWith("<") || !trimmed.endsWith(">")) {
    return null;
  }
  const body = trimmed.slice(1, -1);
  const items = [];
  let start = 0;
  let roundDepth = 0;
  let squareDepth = 0;
  let angleDepth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];
    if (ch === "(") {
      roundDepth += 1;
    } else if (ch === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
    } else if (ch === "[") {
      squareDepth += 1;
    } else if (ch === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
    } else if (ch === "<") {
      angleDepth += 1;
    } else if (ch === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (ch === "," && roundDepth === 0 && squareDepth === 0 && angleDepth === 0) {
      items.push(normalizeTypeText(body.slice(start, index)));
      start = index + 1;
    }
  }
  items.push(normalizeTypeText(body.slice(start)));
  return items.filter(Boolean);
}

function extractLeadingTypeName(typeText) {
  const trimmed = normalizeTypeText(typeText);
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("(")) {
    return null;
  }
  const match = trimmed.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
  return match ? match[0] : null;
}

function extractAppliedGenericBaseType(typeText) {
  const normalized = normalizeTypeText(typeText);
  if (!normalized) {
    return null;
  }
  const leading = extractLeadingTypeName(normalized);
  if (!leading) {
    return null;
  }

  const suffix = normalized.slice(leading.length).trim();
  if (!suffix.startsWith("[") || !suffix.endsWith("]")) {
    return null;
  }

  let squareDepth = 0;
  for (let index = 0; index < suffix.length; index += 1) {
    const ch = suffix[index];
    if (ch === "[") {
      squareDepth += 1;
    } else if (ch === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
      if (squareDepth === 0 && index !== suffix.length - 1) {
        return null;
      }
    }
  }
  if (squareDepth !== 0) {
    return null;
  }

  const body = suffix.slice(1, -1).trim();
  if (!body || /^\d+(?:\s*,\s*\d+)*$/.test(body)) {
    return null;
  }
  return leading;
}

function unwrapTypeForLookup(typeText) {
  let current = normalizeTypeText(typeText);
  if (!current) {
    return null;
  }
  while (true) {
    if (current.endsWith(" dyn")) {
      current = current.slice(0, -4).trim();
      continue;
    }
    if (current.endsWith(" const")) {
      current = current.slice(0, -6).trim();
      continue;
    }
    if (current.endsWith("[*]")) {
      current = current.slice(0, -3).trim();
      continue;
    }
    if (current.endsWith("*")) {
      current = current.slice(0, -1).trim();
      continue;
    }
    break;
  }
  return current;
}

function buildTypeLookupCandidates(typeText, moduleName) {
  const normalized = unwrapTypeForLookup(typeText);
  if (!normalized) {
    return [];
  }
  const candidates = [normalized];
  const appliedGenericBase = extractAppliedGenericBaseType(normalized);
  if (appliedGenericBase && appliedGenericBase !== normalized) {
    candidates.push(appliedGenericBase);
  }
  const qualifiedCandidates = [];
  for (const candidate of candidates) {
    qualifiedCandidates.push(candidate);
    if (moduleName) {
      const localPrefix = `${moduleName}.`;
      if (candidate.startsWith(localPrefix)) {
        qualifiedCandidates.push(candidate.slice(localPrefix.length));
      }
    }
  }
  return Array.from(new Set(qualifiedCandidates.filter(Boolean)));
}

function makeTypeDescriptorFromTypeInfo(typeInfo) {
  return {
    kind: "type",
    members: Array.isArray(typeInfo.members) ? typeInfo.members : [],
    methods: []
  };
}

function makeTupleDescriptor(typeText) {
  const items = splitTupleTypes(typeText);
  if (!items) {
    return null;
  }
  return {
    kind: "type",
    members: items.map((item, index) => ({
      kind: "field",
      name: `_${index + 1}`,
      type: item,
      access: "get"
    })),
    methods: []
  };
}

function builtinDescriptor(typeText) {
  for (const rule of BUILTIN_MEMBER_TABLE) {
    if (rule.match(typeText)) {
      return {
        kind: "type",
        members: rule.members,
        methods: rule.methods
      };
    }
  }
  return null;
}

function makeTypeDescriptorFromPtItem(item) {
  return {
    kind: "type",
    members: item.typeInfo && Array.isArray(item.typeInfo.members) ? item.typeInfo.members : [],
    methods: Array.isArray(item.methods) ? item.methods : []
  };
}

function makeValueDescriptor(type, typeInfo) {
  return {
    kind: "value",
    type: normalizeTypeText(type),
    typeInfo: typeInfo || null
  };
}

function makeDescriptorFromPvItem(item) {
  if (!item) {
    return null;
  }
  if (item.kind === "func") {
    return makeValueDescriptor(parseReturnType(item.signature), null);
  }
  return makeValueDescriptor(item.type, item.typeInfo || null);
}

async function queryTypeReply(queryRunner, typeName, moduleName) {
  const candidates = buildTypeLookupCandidates(typeName, moduleName);
  for (const candidate of candidates) {
    const reply = await queryRunner.pt(candidate, moduleName);
    if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
      continue;
    }
    if (reply.result.item.kind !== "type" && reply.result.item.kind !== "trait") {
      continue;
    }
    return reply;
  }
  return null;
}

function resolveImportedModuleCanonical(document, documentIndex, alias, context) {
  if (!documentIndex.importMap || !documentIndex.importMap.has(alias)) {
    return null;
  }
  const importSymbol = documentIndex.importMap.get(alias);
  const importedPath = resolveImportPath(document.filePath, importSymbol.path, context.rootPaths);
  return canonicalModuleName(importedPath, context.rootPaths);
}

function makeQueryRunner(context, settings) {
  const cache = new Map();

  const execute = (moduleName, line, commands) => {
    const key = [
      moduleName || "",
      typeof line === "number" ? String(line) : "",
      commands.join("\n")
    ].join("::");
    if (!cache.has(key)) {
      cache.set(key, runQueryCommands(context, settings, {
        module: moduleName,
        line,
        commands
      }));
    }
    return cache.get(key);
  };

  return {
    async infoGlobal(moduleName = context.activeModule) {
      return replyByCommand(await execute(moduleName, null, ["info global"]), "info global");
    },
    async infoLocal(line, moduleName = context.activeModule) {
      const command = typeof line === "number" ? `info local ${line}` : "info local";
      return replyByCommand(await execute(moduleName, null, [command]), command);
    },
    async pv(name, line, moduleName = context.activeModule) {
      return replyByCommand(await execute(moduleName, line, [`pv ${name}`]), `pv ${name}`);
    },
    async pt(name, moduleName = context.activeModule) {
      return replyByCommand(await execute(moduleName, null, [`pt ${name}`]), `pt ${name}`);
    },
    async diagnostics(moduleName = context.activeModule) {
      return replyByCommand(await execute(moduleName, null, ["diagnostics"]), "diagnostics");
    }
  };
}

function resolveRootGlobals(infoGlobalReply) {
  return infoGlobalReply && infoGlobalReply.ok && infoGlobalReply.result && Array.isArray(infoGlobalReply.result.items)
    ? infoGlobalReply.result.items
    : [];
}

function resolveLocals(infoLocalReply) {
  return infoLocalReply && infoLocalReply.ok && infoLocalReply.result && Array.isArray(infoLocalReply.result.items)
    ? infoLocalReply.result.items
    : [];
}

function hasLocalScope(infoLocalReply) {
  return Boolean(infoLocalReply && infoLocalReply.ok && infoLocalReply.result && infoLocalReply.result.hasLocalScope);
}

function buildScopeMaps(rootGlobals, locals) {
  const globalsByName = new Map();
  const localsByName = new Map();
  for (const item of rootGlobals) {
    globalsByName.set(item.name, item);
  }
  for (const item of locals) {
    localsByName.set(item.name, item);
  }
  return { globalsByName, localsByName };
}

async function queryTypeDescriptor(queryRunner, typeName, moduleName) {
  const candidates = buildTypeLookupCandidates(typeName, moduleName);
  if (candidates.length === 0) {
    return null;
  }

  const tuple = makeTupleDescriptor(candidates[0]);
  if (tuple) {
    return tuple;
  }

  const builtin = builtinDescriptor(candidates[0]);
  if (builtin) {
    return builtin;
  }

  const reply = await queryTypeReply(queryRunner, typeName, moduleName);
  if (reply && reply.result && reply.result.item) {
    return makeTypeDescriptorFromPtItem(reply.result.item);
  }
  return null;
}

async function resolveValueTarget(name, scopeMaps, queryRunner, line, moduleName) {
  const reply = await queryRunner.pv(name, line, moduleName);
  if (reply && reply.ok && reply.result && reply.result.found && reply.result.item) {
    return makeDescriptorFromPvItem(reply.result.item);
  }

  const global = scopeMaps.globalsByName.get(name);
  if (!global) {
    return null;
  }

  const normalizedKind = normalizeQueryGlobalKind(global.kind);
  if (normalizedKind === "type" || normalizedKind === "trait") {
    return queryTypeDescriptor(queryRunner, name, moduleName);
  }
  return null;
}

async function moduleDescriptorForAlias(document, documentIndex, alias, context, queryRunner) {
  const importedModule = resolveImportedModuleCanonical(document, documentIndex, alias, context);
  if (!importedModule) {
    return null;
  }
  const reply = await queryRunner.infoGlobal(importedModule);
  return {
    kind: "module",
    items: resolveRootGlobals(reply)
  };
}

async function queryDescriptorForType(typeName, valueDescriptor, queryRunner, moduleName) {
  const direct = builtinDescriptor(typeName);
  if (direct) {
    return direct;
  }
  if (valueDescriptor && valueDescriptor.typeInfo && valueDescriptor.typeInfo.hasMembers) {
    const typeDescriptor = makeTypeDescriptorFromTypeInfo(valueDescriptor.typeInfo);
    const printedDescriptor = await queryTypeDescriptor(queryRunner, typeName, moduleName);
    if (printedDescriptor) {
      return {
        kind: "type",
        members: typeDescriptor.members,
        methods: printedDescriptor.methods
      };
    }
    return typeDescriptor;
  }
  return queryTypeDescriptor(queryRunner, typeName, moduleName);
}

async function resolveChainTarget(document, documentIndex, leftExpression, scopeMaps, queryRunner, context, line) {
  const segments = leftExpression.split(".").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  let current = null;
  const first = segments[0];

  if (documentIndex.importMap && documentIndex.importMap.has(first)) {
    current = await moduleDescriptorForAlias(document, documentIndex, first, context, queryRunner);
  } else {
    current = await resolveValueTarget(first, scopeMaps, queryRunner, line, context.activeModule);
  }

  if (!current) {
    return null;
  }

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];

    if (current.kind === "module") {
      const item = current.items.find((candidate) => candidate.name === segment);
      if (!item) {
        return null;
      }
      const normalizedKind = normalizeQueryGlobalKind(item.kind);
      const qualifiedName = `${segments[0]}.${segment}`;
      if (normalizedKind === "type" || normalizedKind === "trait") {
        const reply = await queryRunner.pt(qualifiedName, context.activeModule);
        if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
          return null;
        }
        current = makeTypeDescriptorFromPtItem(reply.result.item);
        continue;
      }
      if (normalizedKind === "func" || normalizedKind === "global") {
        const reply = await queryRunner.pv(qualifiedName, line, context.activeModule);
        if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
          return null;
        }
        current = makeDescriptorFromPvItem(reply.result.item);
        continue;
      }
      return null;
    }

    if (current.kind === "value") {
      const descriptor = await queryDescriptorForType(current.type, current, queryRunner, context.activeModule);
      if (!descriptor) {
        return null;
      }
      current = descriptor;
    }

    if (current.kind === "type") {
      const field = current.members.find((member) => member.name === segment);
      if (field) {
        current = makeValueDescriptor(field.type, field.typeInfo || null);
        continue;
      }
      const method = current.methods.find((member) => member.name === segment);
      if (method) {
        current = makeValueDescriptor(parseReturnType(method.signature || method.detail), null);
        continue;
      }
      return null;
    }
  }

  if (current.kind === "value") {
    return queryDescriptorForType(current.type, current, queryRunner, context.activeModule);
  }
  return current;
}

function memberItemsFromDescriptor(descriptor) {
  if (!descriptor) {
    return [];
  }
  if (descriptor.kind === "module") {
    return descriptor.items
      .map((item) => makeGlobalCompletionItem(item))
      .filter(Boolean);
  }
  if (descriptor.kind === "type") {
    const items = [];
    for (const member of descriptor.members) {
      items.push({
        label: member.name,
        kind: COMPLETION_ITEM_KIND.PROPERTY,
        detail: member.type || member.access || "field"
      });
    }
    for (const method of descriptor.methods) {
      items.push({
        label: method.name,
        kind: COMPLETION_ITEM_KIND.METHOD,
        detail: method.signature || method.detail || "method"
      });
    }
    return items;
  }
  return [];
}

function locationFromQueryLocation(location) {
  if (!location || !location.path) {
    return null;
  }
  const line = Math.max(0, (location.line || 1) - 1);
  const character = Math.max(0, (location.column || 1) - 1);
  return {
    path: normalizePath(location.path),
    range: {
      start: { line, character },
      end: { line, character: character + 1 }
    }
  };
}

function makeHoverInfo(code, text, range) {
  const contents = [];
  if (code) {
    contents.push({
      language: "lona",
      value: code
    });
  }
  if (text) {
    contents.push({
      kind: "plaintext",
      value: text
    });
  }
  if (contents.length === 0) {
    return null;
  }
  return range ? { contents, range } : { contents };
}

function clampActiveParameter(activeParameter, count) {
  if (count <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(activeParameter, count - 1));
}

function makeSignatureHelp(label, parameterLabels, activeParameter) {
  return {
    signatures: [
      {
        label,
        parameters: parameterLabels.map((item) => ({ label: item }))
      }
    ],
    activeSignature: 0,
    activeParameter: clampActiveParameter(activeParameter, parameterLabels.length)
  };
}

function splitSignatureParameters(signature) {
  if (!signature) {
    return [];
  }
  const openIndex = signature.indexOf("(");
  if (openIndex === -1) {
    return [];
  }
  let closeIndex = -1;
  let roundDepth = 0;
  for (let index = openIndex; index < signature.length; index += 1) {
    const ch = signature[index];
    if (ch === "(") {
      roundDepth += 1;
    } else if (ch === ")") {
      roundDepth -= 1;
      if (roundDepth === 0) {
        closeIndex = index;
        break;
      }
    }
  }
  if (closeIndex === -1) {
    return [];
  }
  const body = signature.slice(openIndex + 1, closeIndex);
  if (!body.trim()) {
    return [];
  }

  const items = [];
  let start = 0;
  let nestedRoundDepth = 0;
  let squareDepth = 0;
  let angleDepth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];
    if (ch === "(") {
      nestedRoundDepth += 1;
    } else if (ch === ")") {
      nestedRoundDepth = Math.max(0, nestedRoundDepth - 1);
    } else if (ch === "[") {
      squareDepth += 1;
    } else if (ch === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
    } else if (ch === "<") {
      angleDepth += 1;
    } else if (ch === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (ch === "," && nestedRoundDepth === 0 && squareDepth === 0 && angleDepth === 0) {
      items.push(normalizeTypeText(body.slice(start, index)));
      start = index + 1;
    }
  }
  items.push(normalizeTypeText(body.slice(start)));
  return items.filter(Boolean);
}

function signatureHelpFromSignature(name, signature, receiverAccess, activeParameter) {
  const prefix = receiverAccess === "set" ? "set def" : "def";
  const label = `${prefix} ${name}${signature || ""}`;
  const parameters = splitSignatureParameters(signature);
  return makeSignatureHelp(label, parameters, activeParameter);
}

function signatureHelpFromTypeItem(item, activeParameter) {
  if (!item || item.kind !== "type") {
    return null;
  }
  const members = item.typeInfo && Array.isArray(item.typeInfo.members) ? item.typeInfo.members : [];
  const parameterLabels = members.map((member) => {
    const prefix = member.access === "set" ? "set " : "";
    const suffix = member.type ? ` ${member.type}` : "";
    return `${prefix}${member.name}${suffix}`;
  });
  return makeSignatureHelp(`${item.name}(${parameterLabels.join(", ")})`, parameterLabels, activeParameter);
}

function makeQuerySignatureHover(name, signature, receiverAccess) {
  const prefix = receiverAccess === "set" ? "set def" : "def";
  return `${prefix} ${name}${signature || ""}`;
}

function formatQueryValueHover(item) {
  if (!item) {
    return null;
  }
  if (item.kind === "func") {
    return makeHoverInfo(makeQuerySignatureHover(item.name, item.signature, item.receiverAccess), null, locationFromQueryLocation(item.location) && locationFromQueryLocation(item.location).range);
  }
  if (item.kind === "member") {
    const prefix = item.access === "set" ? "set " : "";
    const suffix = item.type ? ` ${item.type}` : "";
    return makeHoverInfo(`${prefix}${item.name}${suffix}`, item.ownerType ? `owner: ${item.ownerType}` : null, locationFromQueryLocation(item.location) && locationFromQueryLocation(item.location).range);
  }
  if (item.kind === "global") {
    const suffix = item.type ? ` ${item.type}` : "";
    return makeHoverInfo(`global ${item.name}${suffix}`, null, locationFromQueryLocation(item.location) && locationFromQueryLocation(item.location).range);
  }
  const prefix = item.detail || (item.kind === "self" ? "self" : "var");
  const suffix = item.type ? ` ${item.type}` : "";
  return makeHoverInfo(`${prefix} ${item.name}${suffix}`, null, locationFromQueryLocation(item.location) && locationFromQueryLocation(item.location).range);
}

function formatQueryTypeHover(item) {
  if (!item) {
    return null;
  }
  if (item.kind === "trait") {
    return makeHoverInfo(`trait ${item.name}`, null, locationFromQueryLocation(item.location) && locationFromQueryLocation(item.location).range);
  }
  const declKind = item.declKind === "native" || !item.declKind ? "struct" : item.declKind;
  return makeHoverInfo(`${declKind} ${item.name}`, null, locationFromQueryLocation(item.location) && locationFromQueryLocation(item.location).range);
}

function formatQueryGlobalHover(item) {
  if (!item) {
    return null;
  }
  const range = locationFromQueryLocation(item.location) && locationFromQueryLocation(item.location).range;
  switch (item.kind) {
    case "struct":
      return makeHoverInfo(`struct ${item.name}`, null, range);
    case "trait":
      return makeHoverInfo(`trait ${item.name}`, null, range);
    case "func":
    case "method":
      return makeHoverInfo(makeQuerySignatureHover(item.name, item.detail, item.receiverAccess), null, range);
    case "global":
      return makeHoverInfo(`global ${item.name}${item.detail ? ` ${item.detail}` : ""}`, null, range);
    case "field":
      return makeHoverInfo(`${item.name}${item.detail ? ` ${item.detail}` : ""}`, null, range);
    case "import":
      return makeHoverInfo(`import ${item.name}`, null, range);
    default:
      return makeHoverInfo(item.name, item.detail || null, range);
  }
}

function formatQueryMemberHover(member, ownerTypeName, kind) {
  if (!member) {
    return null;
  }
  if (kind === "method") {
    return makeHoverInfo(
      makeQuerySignatureHover(member.name, member.signature || member.detail, member.receiverAccess),
      ownerTypeName ? `owner: ${unwrapTypeForLookup(ownerTypeName)}` : null,
      locationFromQueryLocation(member.location) && locationFromQueryLocation(member.location).range
    );
  }
  const prefix = member.access === "set" ? "set " : "";
  const suffix = member.type ? ` ${member.type}` : "";
  return makeHoverInfo(
    `${prefix}${member.name}${suffix}`,
    ownerTypeName ? `owner: ${unwrapTypeForLookup(ownerTypeName)}` : null,
    locationFromQueryLocation(member.location) && locationFromQueryLocation(member.location).range
  );
}

async function resolveScopeContext(queryRunner, moduleName, line) {
  const infoLocal = await queryRunner.infoLocal(line, moduleName);
  let scopeLine = hasLocalScope(infoLocal) ? line : null;
  let scopeLocalReply = infoLocal;
  if (scopeLine === null) {
    const minLine = Math.max(1, line - 32);
    for (let candidate = line - 1; candidate >= minLine; candidate -= 1) {
      const candidateReply = await queryRunner.infoLocal(candidate, moduleName);
      if (hasLocalScope(candidateReply)) {
        scopeLine = candidate;
        scopeLocalReply = candidateReply;
        break;
      }
    }
  }
  return {
    requestedLine: line,
    scopeLine,
    infoLocal,
    scopeLocalReply
  };
}

function qualifiedTypeNameFromReplyItem(item, fallbackTypeName, fallbackModuleName) {
  if (item && item.qualifiedName) {
    return item.qualifiedName;
  }
  if (item && item.type) {
    return item.type;
  }
  const fallback = extractAppliedGenericBaseType(unwrapTypeForLookup(fallbackTypeName))
    || unwrapTypeForLookup(fallbackTypeName);
  if (!fallback) {
    return null;
  }
  if (fallback.includes(".")) {
    return fallback;
  }
  return fallbackModuleName ? `${fallbackModuleName}.${fallback}` : fallback;
}

function splitQualifiedTypeName(typeName, fallbackModuleName) {
  const normalized = extractAppliedGenericBaseType(unwrapTypeForLookup(typeName))
    || unwrapTypeForLookup(typeName);
  if (!normalized) {
    return null;
  }
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex === -1) {
    return {
      moduleName: fallbackModuleName || null,
      localTypeName: normalized
    };
  }
  return {
    moduleName: normalized.slice(0, dotIndex),
    localTypeName: normalized.slice(dotIndex + 1)
  };
}

async function resolveFieldDefinitionLocation(typeName, fieldName, queryRunner, moduleName) {
  const typeReply = await queryTypeReply(queryRunner, typeName, moduleName);
  if (!typeReply || !typeReply.ok || !typeReply.result || !typeReply.result.found || !typeReply.result.item) {
    return null;
  }

  const typeNameParts = splitQualifiedTypeName(
    qualifiedTypeNameFromReplyItem(typeReply.result.item, typeName, moduleName),
    moduleName
  );
  if (!typeNameParts || !typeNameParts.moduleName) {
    return null;
  }

  const globalsReply = await queryRunner.infoGlobal(typeNameParts.moduleName);
  const globals = resolveRootGlobals(globalsReply);
  const qualifiedFieldName = `${typeNameParts.localTypeName}.${fieldName}`;
  const field = globals.find((item) => item.kind === "field" && item.qualifiedName === qualifiedFieldName);
  return field ? locationFromQueryLocation(field.location) : null;
}

async function advanceDefinitionState(state, segment, queryRunner) {
  if (!state) {
    return null;
  }
  if (state.kind === "module") {
    const globalsReply = await queryRunner.infoGlobal(state.moduleName);
    const globals = resolveRootGlobals(globalsReply);
    const item = globals.find((candidate) => candidate.name === segment);
    if (!item) {
      return null;
    }
    const location = locationFromQueryLocation(item.location);
    const normalizedKind = normalizeQueryGlobalKind(item.kind);
    if (normalizedKind === "type" || normalizedKind === "trait") {
      const reply = await queryRunner.pt(segment, state.moduleName);
      if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
        return null;
      }
      return {
        kind: "type",
        typeName: qualifiedTypeNameFromReplyItem(reply.result.item, segment, state.moduleName),
        moduleName: state.moduleName,
        location
      };
    }
    if (normalizedKind === "func" || normalizedKind === "global") {
      const reply = await queryRunner.pv(segment, null, state.moduleName);
      if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
        return null;
      }
      return {
        kind: "value",
        descriptor: makeDescriptorFromPvItem(reply.result.item),
        moduleName: state.moduleName,
        location
      };
    }
    return null;
  }

  const ownerTypeName = state.kind === "type" ? state.typeName : state.descriptor && state.descriptor.type;
  if (!ownerTypeName) {
    return null;
  }

  const descriptor = state.kind === "type"
    ? await queryTypeDescriptor(queryRunner, ownerTypeName, state.moduleName)
    : await queryDescriptorForType(ownerTypeName, state.descriptor, queryRunner, state.moduleName);
  if (!descriptor) {
    return null;
  }

  const field = descriptor.members.find((member) => member.name === segment);
  if (field) {
    return {
      kind: "value",
      descriptor: makeValueDescriptor(field.type, field.typeInfo || null),
      moduleName: state.moduleName,
      location: await resolveFieldDefinitionLocation(ownerTypeName, segment, queryRunner, state.moduleName)
    };
  }

  const method = descriptor.methods.find((member) => member.name === segment);
  if (method) {
    return {
      kind: "value",
      descriptor: makeValueDescriptor(parseReturnType(method.signature || method.detail), null),
      moduleName: state.moduleName,
      location: locationFromQueryLocation(method.location)
    };
  }

  return null;
}

async function advanceHoverState(state, segment, queryRunner) {
  if (!state) {
    return null;
  }

  if (state.kind === "module") {
    const globalsReply = await queryRunner.infoGlobal(state.moduleName);
    const globals = resolveRootGlobals(globalsReply);
    const item = globals.find((candidate) => candidate.name === segment);
    if (!item) {
      return null;
    }
    const normalizedKind = normalizeQueryGlobalKind(item.kind);
    if (normalizedKind === "type" || normalizedKind === "trait") {
      const reply = await queryRunner.pt(segment, state.moduleName);
      if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
        return null;
      }
      return {
        kind: "type",
        typeName: qualifiedTypeNameFromReplyItem(reply.result.item, segment, state.moduleName),
        moduleName: state.moduleName,
        hover: formatQueryTypeHover(reply.result.item)
      };
    }
    if (normalizedKind === "func" || normalizedKind === "global") {
      const reply = await queryRunner.pv(segment, null, state.moduleName);
      if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
        return null;
      }
      return {
        kind: "value",
        descriptor: makeDescriptorFromPvItem(reply.result.item),
        moduleName: state.moduleName,
        hover: formatQueryValueHover(reply.result.item)
      };
    }
    return {
      kind: "module-item",
      moduleName: state.moduleName,
      hover: formatQueryGlobalHover(item)
    };
  }

  const ownerTypeName = state.kind === "type" ? state.typeName : state.descriptor && state.descriptor.type;
  if (!ownerTypeName) {
    return null;
  }

  const descriptor = state.kind === "type"
    ? await queryTypeDescriptor(queryRunner, ownerTypeName, state.moduleName)
    : await queryDescriptorForType(ownerTypeName, state.descriptor, queryRunner, state.moduleName);
  if (!descriptor) {
    return null;
  }

  const field = descriptor.members.find((member) => member.name === segment);
  if (field) {
    return {
      kind: "value",
      descriptor: makeValueDescriptor(field.type, field.typeInfo || null),
      moduleName: state.moduleName,
      hover: formatQueryMemberHover(field, ownerTypeName, "field")
    };
  }

  const method = descriptor.methods.find((member) => member.name === segment);
  if (method) {
    return {
      kind: "value",
      descriptor: makeValueDescriptor(parseReturnType(method.signature || method.detail), null),
      moduleName: state.moduleName,
      hover: formatQueryMemberHover(method, ownerTypeName, "method")
    };
  }

  return null;
}

async function resolveQueryDefinitionLocation(document, documentIndex, position, settings) {
  if (!canUseQueryBackend(document, settings)) {
    return null;
  }

  const context = resolveQueryContext(document, settings);
  if (!context) {
    return null;
  }

  const offset = positionToOffset(document.text, position);
  const reference = getReferenceContext(documentIndex, offset);
  if (!reference || !reference.segments.length) {
    return null;
  }

  const queryRunner = makeQueryRunner(context, settings);
  const rootGlobalReply = await queryRunner.infoGlobal(context.activeModule);
  const line = position.line + 1;
  const scopeContext = await resolveScopeContext(queryRunner, context.activeModule, line);
  const rootGlobals = resolveRootGlobals(rootGlobalReply);
  const locals = resolveLocals(scopeContext.scopeLocalReply);
  const scopeMaps = buildScopeMaps(rootGlobals, locals);

  let state = null;
  const rootName = reference.segments[0];
  if (scopeMaps.localsByName.has(rootName)) {
    const local = scopeMaps.localsByName.get(rootName);
    const reply = await queryRunner.pv(rootName, scopeContext.scopeLine, context.activeModule);
    state = {
      kind: "value",
      descriptor: reply && reply.ok && reply.result && reply.result.found && reply.result.item
        ? makeDescriptorFromPvItem(reply.result.item)
        : makeValueDescriptor(local.type, null),
      moduleName: context.activeModule,
      location: locationFromQueryLocation(local.location)
    };
  } else if (documentIndex.importMap && documentIndex.importMap.has(rootName)) {
    const importedModule = resolveImportedModuleCanonical(document, documentIndex, rootName, context);
    if (!importedModule) {
      return null;
    }
    state = {
      kind: "module",
      moduleName: importedModule,
      location: null
    };
  } else if (scopeMaps.globalsByName.has(rootName)) {
    const item = scopeMaps.globalsByName.get(rootName);
    const location = locationFromQueryLocation(item.location);
    const normalizedKind = normalizeQueryGlobalKind(item.kind);
    if (normalizedKind === "type" || normalizedKind === "trait") {
      const reply = await queryRunner.pt(rootName, context.activeModule);
      if (reply && reply.ok && reply.result && reply.result.found && reply.result.item) {
        state = {
          kind: "type",
          typeName: qualifiedTypeNameFromReplyItem(reply.result.item, rootName, context.activeModule),
          moduleName: context.activeModule,
          location
        };
      }
    } else if (normalizedKind === "func" || normalizedKind === "global") {
      const reply = await queryRunner.pv(rootName, scopeContext.scopeLine, context.activeModule);
      if (reply && reply.ok && reply.result && reply.result.found && reply.result.item) {
        state = {
          kind: "value",
          descriptor: makeDescriptorFromPvItem(reply.result.item),
          moduleName: context.activeModule,
          location
        };
      }
    }
  }

  if (!state) {
    return null;
  }
  if (reference.targetSegmentIndex === 0) {
    return state.location || null;
  }

  for (let index = 1; index < reference.segments.length; index += 1) {
    state = await advanceDefinitionState(state, reference.segments[index], queryRunner);
    if (!state) {
      return null;
    }
    if (index === reference.targetSegmentIndex) {
      return state.location || null;
    }
  }

  return null;
}

async function buildQueryCompletionItems(document, documentIndex, position, settings, workspaceFolders) {
  if (!canUseQueryBackend(document, settings)) {
    return null;
  }

  const context = resolveQueryContext(document, settings);
  if (!context) {
    return null;
  }

  const queryRunner = makeQueryRunner(context, settings);
  const rootGlobalReply = await queryRunner.infoGlobal(context.activeModule);
  const line = position.line + 1;
  const scopeContext = await resolveScopeContext(queryRunner, context.activeModule, line);
  const rootGlobals = resolveRootGlobals(rootGlobalReply);
  const locals = resolveLocals(scopeContext.scopeLocalReply);
  const scopeMaps = buildScopeMaps(rootGlobals, locals);
  const offset = positionToOffset(document.text, position);
  const completionContext = getCompletionContext(document.text, offset);
  const items = new Map();

  if (!completionContext.dotAccess) {
    for (const item of keywordItems()) {
      addCompletion(items, item);
    }
    for (const local of locals) {
      addCompletion(items, makeLocalCompletionItem(local));
    }
    for (const global of rootGlobals) {
      const completion = makeGlobalCompletionItem(global);
      if (completion) {
        addCompletion(items, completion);
      }
    }
    return Array.from(items.values()).sort((left, right) => left.label.localeCompare(right.label, "en"));
  }

    const descriptor = await resolveChainTarget(
      document,
      documentIndex,
      completionContext.leftExpression,
      scopeMaps,
      queryRunner,
      context,
      scopeContext.scopeLine
    );
  for (const item of memberItemsFromDescriptor(descriptor)) {
    addCompletion(items, item);
  }
  return Array.from(items.values()).sort((left, right) => left.label.localeCompare(right.label, "en"));
}

async function findQueryHoverInfo(document, documentIndex, position, settings) {
  if (!canUseQueryBackend(document, settings)) {
    return null;
  }

  const context = resolveQueryContext(document, settings);
  if (!context) {
    return null;
  }

  const offset = positionToOffset(document.text, position);
  const reference = getReferenceContext(documentIndex, offset);
  if (!reference || !reference.segments.length) {
    return null;
  }

  const queryRunner = makeQueryRunner(context, settings);
  const rootGlobalReply = await queryRunner.infoGlobal(context.activeModule);
  const line = position.line + 1;
  const scopeContext = await resolveScopeContext(queryRunner, context.activeModule, line);
  const rootGlobals = resolveRootGlobals(rootGlobalReply);
  const locals = resolveLocals(scopeContext.scopeLocalReply);
  const scopeMaps = buildScopeMaps(rootGlobals, locals);

  let state = null;
  const rootName = reference.segments[0];
  if (scopeMaps.localsByName.has(rootName)) {
    const reply = await queryRunner.pv(rootName, scopeContext.scopeLine, context.activeModule);
    if (reply && reply.ok && reply.result && reply.result.found && reply.result.item) {
      state = {
        kind: "value",
        descriptor: makeDescriptorFromPvItem(reply.result.item),
        moduleName: context.activeModule,
        hover: formatQueryValueHover(reply.result.item)
      };
    } else {
      const local = scopeMaps.localsByName.get(rootName);
      state = {
        kind: "value",
        descriptor: makeValueDescriptor(local.type, null),
        moduleName: context.activeModule,
        hover: makeHoverInfo(`${local.detail || "var"} ${local.name}${local.type ? ` ${local.type}` : ""}`, null, locationFromQueryLocation(local.location) && locationFromQueryLocation(local.location).range)
      };
    }
  } else if (documentIndex.importMap && documentIndex.importMap.has(rootName)) {
    const importSymbol = documentIndex.importMap.get(rootName);
    state = {
      kind: "module",
      moduleName: resolveImportedModuleCanonical(document, documentIndex, rootName, context),
      hover: makeHoverInfo(`import ${importSymbol.path}`, null, importSymbol.range || null)
    };
  } else if (scopeMaps.globalsByName.has(rootName)) {
    const item = scopeMaps.globalsByName.get(rootName);
    const normalizedKind = normalizeQueryGlobalKind(item.kind);
    if (normalizedKind === "type" || normalizedKind === "trait") {
      const reply = await queryRunner.pt(rootName, context.activeModule);
      if (reply && reply.ok && reply.result && reply.result.found && reply.result.item) {
        state = {
          kind: "type",
          typeName: qualifiedTypeNameFromReplyItem(reply.result.item, rootName, context.activeModule),
          moduleName: context.activeModule,
          hover: formatQueryTypeHover(reply.result.item)
        };
      }
    } else if (normalizedKind === "func" || normalizedKind === "global") {
      const reply = await queryRunner.pv(rootName, scopeContext.scopeLine, context.activeModule);
      if (reply && reply.ok && reply.result && reply.result.found && reply.result.item) {
        state = {
          kind: "value",
          descriptor: makeDescriptorFromPvItem(reply.result.item),
          moduleName: context.activeModule,
          hover: formatQueryValueHover(reply.result.item)
        };
      }
    } else {
      state = {
        kind: "module-item",
        moduleName: context.activeModule,
        hover: formatQueryGlobalHover(item)
      };
    }
  }

  if (!state || !state.hover) {
    return null;
  }
  if (reference.targetSegmentIndex === 0) {
    return state.hover;
  }

  for (let index = 1; index < reference.segments.length; index += 1) {
    state = await advanceHoverState(state, reference.segments[index], queryRunner);
    if (!state || !state.hover) {
      return null;
    }
    if (index === reference.targetSegmentIndex) {
      return state.hover;
    }
  }

  return null;
}

async function findQuerySignatureHelp(document, documentIndex, position, settings) {
  if (!canUseQueryBackend(document, settings)) {
    return null;
  }

  const context = resolveQueryContext(document, settings);
  if (!context) {
    return null;
  }

  const offset = positionToOffset(document.text, position);
  const signatureContext = getSignatureContext(documentIndex, offset);
  if (!signatureContext || !signatureContext.segments.length) {
    return null;
  }

  const queryRunner = makeQueryRunner(context, settings);
  const line = position.line + 1;
  const rootGlobalReply = await queryRunner.infoGlobal(context.activeModule);
  const scopeContext = await resolveScopeContext(queryRunner, context.activeModule, line);
  const rootGlobals = resolveRootGlobals(rootGlobalReply);
  const locals = resolveLocals(scopeContext.scopeLocalReply);
  const scopeMaps = buildScopeMaps(rootGlobals, locals);

  let state = null;
  const rootName = signatureContext.segments[0];
  if (scopeMaps.localsByName.has(rootName)) {
    const reply = await queryRunner.pv(rootName, scopeContext.scopeLine, context.activeModule);
    if (reply && reply.ok && reply.result && reply.result.found && reply.result.item) {
      if (reply.result.item.kind === "func") {
        return signatureHelpFromSignature(
          reply.result.item.name,
          reply.result.item.signature || "",
          reply.result.item.receiverAccess,
          signatureContext.activeParameter
        );
      }
      state = {
        kind: "value",
        descriptor: makeDescriptorFromPvItem(reply.result.item),
        moduleName: context.activeModule
      };
    }
  } else if (documentIndex.importMap && documentIndex.importMap.has(rootName)) {
    const moduleName = resolveImportedModuleCanonical(document, documentIndex, rootName, context);
    if (!moduleName) {
      return null;
    }
    state = {
      kind: "module",
      moduleName
    };
  } else if (scopeMaps.globalsByName.has(rootName)) {
    const item = scopeMaps.globalsByName.get(rootName);
    const normalizedKind = normalizeQueryGlobalKind(item.kind);
    if (normalizedKind === "type") {
      const reply = await queryRunner.pt(rootName, context.activeModule);
      if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
        return null;
      }
      if (signatureContext.segments.length === 1) {
        return signatureHelpFromTypeItem(reply.result.item, signatureContext.activeParameter);
      }
      state = {
        kind: "type",
        typeName: qualifiedTypeNameFromReplyItem(reply.result.item, rootName, context.activeModule),
        moduleName: context.activeModule,
        descriptor: makeTypeDescriptorFromPtItem(reply.result.item)
      };
    } else if (normalizedKind === "func") {
      const reply = await queryRunner.pv(rootName, scopeContext.scopeLine, context.activeModule);
      if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
        return null;
      }
      if (signatureContext.segments.length === 1) {
        return signatureHelpFromSignature(
          reply.result.item.name,
          reply.result.item.signature || "",
          reply.result.item.receiverAccess,
          signatureContext.activeParameter
        );
      }
      state = {
        kind: "value",
        descriptor: makeDescriptorFromPvItem(reply.result.item),
        moduleName: context.activeModule
      };
    } else if (normalizedKind === "global") {
      const reply = await queryRunner.pv(rootName, scopeContext.scopeLine, context.activeModule);
      if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
        return null;
      }
      state = {
        kind: "value",
        descriptor: makeDescriptorFromPvItem(reply.result.item),
        moduleName: context.activeModule
      };
    } else {
      return null;
    }
  }

  if (!state) {
    return null;
  }

  for (let index = 1; index < signatureContext.segments.length; index += 1) {
    const segment = signatureContext.segments[index];

    if (state.kind === "module") {
      const globalsReply = await queryRunner.infoGlobal(state.moduleName);
      const globals = resolveRootGlobals(globalsReply);
      const item = globals.find((candidate) => candidate.name === segment);
      if (!item) {
        return null;
      }
      const normalizedKind = normalizeQueryGlobalKind(item.kind);
      if (normalizedKind === "type") {
        const reply = await queryRunner.pt(segment, state.moduleName);
        if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
          return null;
        }
        if (index === signatureContext.segments.length - 1) {
          return signatureHelpFromTypeItem(reply.result.item, signatureContext.activeParameter);
        }
        state = {
          kind: "type",
          typeName: qualifiedTypeNameFromReplyItem(reply.result.item, segment, state.moduleName),
          moduleName: state.moduleName,
          descriptor: makeTypeDescriptorFromPtItem(reply.result.item)
        };
        continue;
      }
      if (normalizedKind === "func") {
        const reply = await queryRunner.pv(segment, null, state.moduleName);
        if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
          return null;
        }
        if (index === signatureContext.segments.length - 1) {
          return signatureHelpFromSignature(
            reply.result.item.name,
            reply.result.item.signature || "",
            reply.result.item.receiverAccess,
            signatureContext.activeParameter
          );
        }
        state = {
          kind: "value",
          descriptor: makeDescriptorFromPvItem(reply.result.item),
          moduleName: state.moduleName
        };
        continue;
      }
      if (normalizedKind === "global") {
        const reply = await queryRunner.pv(segment, null, state.moduleName);
        if (!reply || !reply.ok || !reply.result || !reply.result.found || !reply.result.item) {
          return null;
        }
        state = {
          kind: "value",
          descriptor: makeDescriptorFromPvItem(reply.result.item),
          moduleName: state.moduleName
        };
        continue;
      }
      return null;
    }

    let descriptor = null;
    if (state.kind === "value") {
      descriptor = await queryDescriptorForType(state.descriptor.type, state.descriptor, queryRunner, state.moduleName);
    } else if (state.kind === "type") {
      descriptor = state.descriptor || await queryTypeDescriptor(queryRunner, state.typeName, state.moduleName);
    }
    if (!descriptor) {
      return null;
    }

    const field = descriptor.members.find((member) => member.name === segment);
    if (field) {
      state = {
        kind: "value",
        descriptor: makeValueDescriptor(field.type, field.typeInfo || null),
        moduleName: state.moduleName
      };
      continue;
    }

    const method = descriptor.methods.find((member) => member.name === segment);
    if (method) {
      if (index === signatureContext.segments.length - 1) {
        return signatureHelpFromSignature(
          method.name,
          method.signature || method.detail || "",
          method.receiverAccess,
          signatureContext.activeParameter
        );
      }
      state = {
        kind: "value",
        descriptor: makeValueDescriptor(parseReturnType(method.signature || method.detail), null),
        moduleName: state.moduleName
      };
      continue;
    }

    return null;
  }

  return null;
}

async function runQueryDiagnostics(document, settings) {
  if (!canUseQueryBackend(document, settings)) {
    return null;
  }

  const context = resolveQueryContext(document, settings);
  if (!context) {
    return null;
  }

  const queryRunner = makeQueryRunner(context, settings);
  return diagnosticsFromQueryReply(await queryRunner.diagnostics(context.activeModule));
}

module.exports = {
  buildQueryCompletionItems,
  canUseQueryBackend,
  canonicalModuleName,
  closeAllQuerySessions,
  getActiveQuerySessionCount,
  findQueryDefinitionLocation: resolveQueryDefinitionLocation,
  findQueryHoverInfo,
  findQuerySignatureHelp,
  markQuerySessionDirty,
  resolveQueryContext,
  runQueryCommands,
  runQueryDiagnostics
};
