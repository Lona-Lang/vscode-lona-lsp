"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

const {
  buildCompletionItems,
  buildDocumentIndex,
  findDefinitionLocation,
  findHoverInfo,
  findSignatureHelp,
  getReferenceContext,
  positionToOffset,
  resolveImportPath
} = require("./lona-index");
const {
  buildQueryCompletionItems,
  closeAllQuerySessions,
  findQueryDefinitionLocation,
  findQueryHoverInfo,
  findQuerySignatureHelp,
  markQuerySessionDirty,
  resolveQueryContext,
  runQueryDiagnostics
} = require("./lona-query");
const { buildModuleRoots } = require("./module-roots");

const QUERY_IDLE_RELOAD_MS = 500;
const REQUEST_WARNING_MS = 3000;

function formatLogMessage(message) {
  if (message instanceof Error) {
    return message.stack || message.message || String(message);
  }
  return String(message);
}

function summarizeParams(method, params) {
  if (!params) {
    return "";
  }
  switch (method) {
    case "initialize":
      return `workspaceFolders=${Array.isArray(params.workspaceFolders) ? params.workspaceFolders.length : 0}`;
    case "textDocument/completion":
    case "textDocument/definition":
    case "textDocument/hover":
    case "textDocument/signatureHelp": {
      const uri = params.textDocument && params.textDocument.uri ? params.textDocument.uri : "<unknown>";
      const line = params.position ? params.position.line : "?";
      const character = params.position ? params.position.character : "?";
      return `uri=${uri} position=${line}:${character}`;
    }
    case "textDocument/didOpen":
      return `uri=${params.textDocument && params.textDocument.uri ? params.textDocument.uri : "<unknown>"} version=${params.textDocument && typeof params.textDocument.version === "number" ? params.textDocument.version : "?"}`;
    case "textDocument/didChange":
      return `uri=${params.textDocument && params.textDocument.uri ? params.textDocument.uri : "<unknown>"} version=${params.textDocument && typeof params.textDocument.version === "number" ? params.textDocument.version : "?"} changes=${Array.isArray(params.contentChanges) ? params.contentChanges.length : 0}`;
    case "textDocument/didSave":
    case "textDocument/didClose":
      return `uri=${params.textDocument && params.textDocument.uri ? params.textDocument.uri : "<unknown>"}`;
    case "workspace/didChangeConfiguration":
      return "settings-updated";
    default:
      return "";
  }
}

function countLineBreaks(text) {
  const matches = text.match(/\r\n|\r|\n/g);
  return matches ? matches.length : 0;
}

function uriToPath(uri) {
  if (!uri || !uri.startsWith("file:")) {
    return null;
  }
  return path.normalize(fileURLToPath(uri));
}

function pathToUri(filePath) {
  return pathToFileURL(filePath).toString();
}

function makeFileEntryLocation(filePath) {
  if (!filePath) {
    return null;
  }
  return {
    path: path.normalize(filePath),
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 }
    }
  };
}

class JsonRpcConnection {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.handlers = new Set();
    this.input.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });
  }

  onMessage(handler) {
    this.handlers.add(handler);
  }

  send(message) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
    this.output.write(Buffer.concat([header, payload]));
  }

  processBuffer() {
    while (true) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator === -1) {
        return;
      }
      const header = this.buffer.slice(0, separator).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const length = Number.parseInt(match[1], 10);
      const messageStart = separator + 4;
      if (this.buffer.length < messageStart + length) {
        return;
      }
      const body = this.buffer.slice(messageStart, messageStart + length).toString("utf8");
      this.buffer = this.buffer.slice(messageStart + length);
      const message = JSON.parse(body);
      for (const handler of this.handlers) {
        handler(message);
      }
    }
  }
}

class LonaLanguageServer {
  constructor(connection) {
    this.connection = connection;
    this.documents = new Map();
    this.workspaceFolders = [];
    this.settings = {
      rootPaths: [],
      autoRootPaths: [],
      enableDiagnostics: true,
      queryPath: "lona-query",
      preferQueryBackend: true
    };
    this.moduleCache = new Map();
    this.queryIdleTimers = new Map();
    this.queryPublishedDiagnosticsUris = new Set();
    this.shutdownRequested = false;
  }

  logServer(level, scope, message) {
    const rendered = formatLogMessage(message);
    try {
      for (const line of rendered.split(/\r?\n/)) {
        process.stderr.write(`[lona-lsp][${level}][${scope}] ${line}\n`);
      }
    } catch {
      // Ignore logging failures.
    }
  }

  logServerError(scope, error) {
    this.logServer("error", scope, error);
  }

  handleMessage(message) {
    if (typeof message.id !== "undefined" && message.method) {
      const scope = `request:${message.method}#${message.id}`;
      const startedAt = Date.now();
      this.logServer("info", scope, `start ${summarizeParams(message.method, message.params || {})}`.trim());
      const warningTimer = setTimeout(() => {
        this.logServer("warn", scope, `still running after ${REQUEST_WARNING_MS}ms`);
      }, REQUEST_WARNING_MS);
      if (typeof warningTimer.unref === "function") {
        warningTimer.unref();
      }
      Promise.resolve(this.handleRequest(message.method, message.params || {}))
        .then((result) => {
          clearTimeout(warningTimer);
          this.logServer("info", scope, `done in ${Date.now() - startedAt}ms`);
          this.connection.send({
            jsonrpc: "2.0",
            id: message.id,
            result
          });
        })
        .catch((error) => {
          clearTimeout(warningTimer);
          this.logServerError(scope, error);
          this.connection.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: error && error.message ? error.message : String(error)
            }
          });
        });
      return;
    }
    if (message.method) {
      const scope = `notification:${message.method}`;
      const startedAt = Date.now();
      this.logServer("trace", scope, `start ${summarizeParams(message.method, message.params || {})}`.trim());
      const warningTimer = setTimeout(() => {
        this.logServer("warn", scope, `still running after ${REQUEST_WARNING_MS}ms`);
      }, REQUEST_WARNING_MS);
      if (typeof warningTimer.unref === "function") {
        warningTimer.unref();
      }
      Promise.resolve()
        .then(() => this.handleNotification(message.method, message.params || {}))
        .then(() => {
          clearTimeout(warningTimer);
          this.logServer("trace", scope, `done in ${Date.now() - startedAt}ms`);
        })
        .catch((error) => {
          clearTimeout(warningTimer);
          this.logServerError(`notification:${message.method}`, error);
        });
    }
  }

  async handleRequest(method, params) {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "shutdown":
        this.shutdownRequested = true;
        this.clearAllQueryIdleTimers();
        closeAllQuerySessions();
        return null;
      case "textDocument/completion":
        return this.provideCompletion(params);
      case "textDocument/definition":
        return this.provideDefinition(params);
      case "textDocument/hover":
        return this.provideHover(params);
      case "textDocument/signatureHelp":
        return this.provideSignatureHelp(params);
      default:
        return null;
    }
  }

  async handleNotification(method, params) {
    switch (method) {
      case "initialized":
        return;
      case "exit":
        this.clearAllQueryIdleTimers();
        closeAllQuerySessions();
        process.exit(this.shutdownRequested ? 0 : 1);
        return;
      case "textDocument/didOpen":
        this.openDocument(params.textDocument);
        return;
      case "textDocument/didChange":
        this.changeDocument(params);
        return;
      case "textDocument/didSave":
        this.saveDocument(params.textDocument);
        return;
      case "textDocument/didClose":
        this.closeDocument(params.textDocument);
        return;
      case "workspace/didChangeConfiguration":
        this.clearAllQueryIdleTimers();
        closeAllQuerySessions();
        this.settings = {
          ...this.settings,
          ...(params.settings || {})
        };
        this.updateAutomaticRootPaths();
        this.refreshAllDiagnostics();
        return;
      default:
        return;
    }
  }

  initialize(params) {
    if (Array.isArray(params.workspaceFolders)) {
      this.workspaceFolders = params.workspaceFolders
        .map((folder) => uriToPath(folder.uri))
        .filter(Boolean);
    } else if (params.rootUri) {
      const rootPath = uriToPath(params.rootUri);
      this.workspaceFolders = rootPath ? [rootPath] : [];
    }
    this.settings = {
      ...this.settings,
      ...(params.initializationOptions || {})
    };
    this.updateAutomaticRootPaths();
    this.logServer("info", "initialize", `workspaceFolders=${this.workspaceFolders.length} rootPaths=${(this.settings.rootPaths || []).length} preferQueryBackend=${this.settings.preferQueryBackend !== false}`);
    return {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: ["."]
        },
        definitionProvider: true,
        hoverProvider: true,
        signatureHelpProvider: {
          triggerCharacters: ["(", ","]
        }
      }
    };
  }

  openDocument(textDocument) {
    this.logServer("trace", "document", `open uri=${textDocument.uri} version=${textDocument.version}`);
    const document = this.createDocumentState(textDocument);
    this.documents.set(textDocument.uri, document);
    this.ensureAutomaticRootPathsForDocument(document);
    this.invalidateModuleForDocument(textDocument.uri);
    this.refreshDiagnosticsSafely(textDocument.uri);
  }

  changeDocument(params) {
    const existing = this.documents.get(params.textDocument.uri);
    if (!existing || !params.contentChanges.length) {
      return;
    }
    this.logServer("trace", "document", `change uri=${params.textDocument.uri} version=${params.textDocument.version}`);
    const latestChange = params.contentChanges[params.contentChanges.length - 1];
    const previousText = existing.text;
    existing.text = latestChange.text;
    existing.version = params.textDocument.version;
    existing.index = null;
    if (
      this.settings.preferQueryBackend !== false &&
      resolveQueryContext(existing, this.settings) &&
      countLineBreaks(previousText) !== countLineBreaks(existing.text)
    ) {
      this.logServer("trace", "query", `mark dirty from line-count change uri=${existing.uri}`);
      markQuerySessionDirty(existing, this.settings);
    }
    this.scheduleQueryIdleReload(existing.uri);
    this.invalidateModuleForDocument(existing.uri);
    this.refreshDiagnosticsSafely(existing.uri);
  }

  saveDocument(textDocument) {
    const existing = this.documents.get(textDocument.uri);
    if (!existing) {
      return;
    }
    this.logServer("trace", "document", `save uri=${textDocument.uri} version=${existing.version}`);
    this.clearQueryIdleReload(textDocument.uri);
    if (this.settings.preferQueryBackend !== false && resolveQueryContext(existing, this.settings)) {
      this.logServer("trace", "query", `mark dirty from save uri=${existing.uri}`);
      markQuerySessionDirty(existing, this.settings);
    }
    this.refreshDiagnosticsSafely(textDocument.uri);
  }

  closeDocument(textDocument) {
    this.logServer("trace", "document", `close uri=${textDocument.uri}`);
    this.clearQueryIdleReload(textDocument.uri);
    this.documents.delete(textDocument.uri);
    this.invalidateModuleForDocument(textDocument.uri);
    this.queryPublishedDiagnosticsUris.delete(textDocument.uri);
    this.publishDiagnostics(textDocument.uri, []);
  }

  createDocumentState(textDocument) {
    return {
      uri: textDocument.uri,
      filePath: uriToPath(textDocument.uri),
      text: textDocument.text,
      version: textDocument.version,
      index: null
    };
  }

  getDocument(uri) {
    return this.documents.get(uri) || null;
  }

  updateAutomaticRootPaths() {
    if (Array.isArray(this.settings.rootPaths) && this.settings.rootPaths.length > 0) {
      this.settings.autoRootPaths = [];
      return;
    }
    if (this.workspaceFolders.length > 0) {
      this.settings.autoRootPaths = this.workspaceFolders.slice();
      return;
    }
    if (!Array.isArray(this.settings.autoRootPaths)) {
      this.settings.autoRootPaths = [];
    }
  }

  ensureAutomaticRootPathsForDocument(document) {
    if (Array.isArray(this.settings.rootPaths) && this.settings.rootPaths.length > 0) {
      return;
    }
    if (Array.isArray(this.settings.autoRootPaths) && this.settings.autoRootPaths.length > 0) {
      return;
    }
    if (!document || !document.filePath) {
      return;
    }
    this.settings.autoRootPaths = [path.dirname(path.normalize(document.filePath))];
    this.logServer("info", "initialize", `auto root path=${this.settings.autoRootPaths[0]}`);
  }

  findOpenDocumentByFilePath(filePath) {
    const normalizedPath = path.normalize(filePath);
    return Array.from(this.documents.values()).find((candidate) => candidate.filePath === normalizedPath) || null;
  }

  documentMatchesDisk(document) {
    if (!document || !document.filePath) {
      return false;
    }
    try {
      return fs.readFileSync(document.filePath, "utf8") === document.text;
    } catch {
      return false;
    }
  }

  shouldPublishQueryDiagnosticsToUri(targetUri) {
    const targetPath = uriToPath(targetUri);
    if (!targetPath) {
      return true;
    }
    const openDocument = this.findOpenDocumentByFilePath(targetPath);
    if (!openDocument) {
      return true;
    }
    return this.documentMatchesDisk(openDocument);
  }

  getOrBuildIndex(document) {
    if (!document.index) {
      document.index = buildDocumentIndex({
        uri: document.uri,
        filePath: document.filePath,
        text: document.text
      });
    }
    return document.index;
  }

  invalidateModuleForDocument(uri) {
    const filePath = uriToPath(uri);
    if (!filePath) {
      return;
    }
    this.moduleCache.delete(path.normalize(filePath));
  }

  scheduleQueryIdleReload(uri) {
    this.clearQueryIdleReload(uri);
    const document = this.getDocument(uri);
    if (!document || this.settings.preferQueryBackend === false || !resolveQueryContext(document, this.settings)) {
      return;
    }
    this.logServer("trace", "query", `schedule idle reload uri=${uri} delay=${QUERY_IDLE_RELOAD_MS}ms`);
    const timer = setTimeout(() => {
      this.queryIdleTimers.delete(uri);
      const latest = this.getDocument(uri);
      if (!latest || this.settings.preferQueryBackend === false || !resolveQueryContext(latest, this.settings)) {
        return;
      }
      this.logServer("trace", "query", `idle reload fired uri=${uri}`);
      markQuerySessionDirty(latest, this.settings);
      this.refreshDiagnosticsSafely(uri);
    }, QUERY_IDLE_RELOAD_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.queryIdleTimers.set(uri, timer);
  }

  clearQueryIdleReload(uri) {
    const timer = this.queryIdleTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.queryIdleTimers.delete(uri);
      this.logServer("trace", "query", `clear idle reload uri=${uri}`);
    }
  }

  clearAllQueryIdleTimers() {
    for (const timer of this.queryIdleTimers.values()) {
      clearTimeout(timer);
    }
    this.queryIdleTimers.clear();
  }

  refreshDiagnosticsSafely(uri) {
    this.refreshDiagnostics(uri).catch((error) => {
      this.logServerError(`diagnostics:${uri}`, error);
    });
  }

  async queryCompletionItems(document, documentIndex, position) {
    return buildQueryCompletionItems(
      document,
      documentIndex,
      position,
      this.settings,
      this.workspaceFolders
    );
  }

  async queryDefinitionLocation(document, documentIndex, position) {
    return findQueryDefinitionLocation(document, documentIndex, position, this.settings);
  }

  async queryHoverInfo(document, documentIndex, position) {
    return findQueryHoverInfo(document, documentIndex, position, this.settings);
  }

  async querySignatureHelp(document, documentIndex, position) {
    return findQuerySignatureHelp(document, documentIndex, position, this.settings);
  }

  async queryDiagnostics(document) {
    return runQueryDiagnostics(document, this.settings);
  }

  resolveModuleIndex(currentDocument, importSymbol) {
    const resolvedPath = this.resolveModulePath(currentDocument.filePath, importSymbol);
    if (!resolvedPath) {
      return null;
    }
    return this.loadModuleIndex(resolvedPath);
  }

  resolveModulePath(currentFilePath, importSymbol) {
    if (!currentFilePath || !importSymbol) {
      return null;
    }
    return resolveImportPath(
      currentFilePath,
      importSymbol.path,
      buildModuleRoots({ filePath: currentFilePath }, this.settings)
    );
  }

  resolveModuleDefinitionLocation(currentDocument, documentIndex, position) {
    const offset = positionToOffset(currentDocument.text, position);
    const reference = getReferenceContext(documentIndex, offset);
    if (!reference || reference.targetSegmentIndex !== 0 || !reference.segments.length) {
      return null;
    }
    const importSymbol = documentIndex.importMap.get(reference.segments[0]);
    if (!importSymbol) {
      return null;
    }
    const moduleIndex = this.resolveModuleIndex(currentDocument, importSymbol);
    return moduleIndex && moduleIndex.filePath ? makeFileEntryLocation(moduleIndex.filePath) : null;
  }

  collectDiagnosticScopePaths(document, documentIndex) {
    const reachablePaths = new Set();

    const visit = (filePath, index) => {
      const normalizedPath = filePath ? path.normalize(filePath) : null;
      if (!normalizedPath || reachablePaths.has(normalizedPath)) {
        return;
      }
      reachablePaths.add(normalizedPath);
      const moduleIndex = index || this.loadModuleIndex(normalizedPath);
      if (!moduleIndex || !Array.isArray(moduleIndex.imports)) {
        return;
      }
      for (const importSymbol of moduleIndex.imports) {
        const importedPath = this.resolveModulePath(moduleIndex.filePath, importSymbol);
        if (!importedPath) {
          continue;
        }
        visit(importedPath, this.loadModuleIndex(importedPath));
      }
    };

    visit(document.filePath, documentIndex);
    return reachablePaths;
  }

  loadModuleIndex(filePath) {
    const normalizedPath = path.normalize(filePath);
    const openDocument = Array.from(this.documents.values()).find((candidate) => candidate.filePath === normalizedPath);
    if (openDocument) {
      return this.getOrBuildIndex(openDocument);
    }

    try {
      const stat = fs.statSync(normalizedPath);
      const cached = this.moduleCache.get(normalizedPath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.index;
      }
      const text = fs.readFileSync(normalizedPath, "utf8");
      const index = buildDocumentIndex({
        uri: pathToUri(normalizedPath),
        filePath: normalizedPath,
        text
      });
      this.moduleCache.set(normalizedPath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        index
      });
      return index;
    } catch {
      return null;
    }
  }

  async provideCompletion(params) {
    const document = this.getDocument(params.textDocument.uri);
    if (!document) {
      return [];
    }
    const documentIndex = this.getOrBuildIndex(document);
    let queryItems = null;
    try {
      queryItems = await this.queryCompletionItems(document, documentIndex, params.position);
    } catch (error) {
      this.logServerError(`completion:${document.filePath || document.uri}`, error);
    }
    if (queryItems !== null) {
      this.logServer("trace", "completion", `query result uri=${document.uri} count=${queryItems.length}`);
      return queryItems;
    }
    const offset = positionToOffset(document.text, params.position);
    this.logServer("trace", "completion", `fallback local index uri=${document.uri}`);
    return buildCompletionItems(documentIndex, offset, (importSymbol) => this.resolveModuleIndex(document, importSymbol));
  }

  async provideDefinition(params) {
    const document = this.getDocument(params.textDocument.uri);
    if (!document) {
      return null;
    }
    const documentIndex = this.getOrBuildIndex(document);
    const moduleLocation = this.resolveModuleDefinitionLocation(document, documentIndex, params.position);
    if (moduleLocation && moduleLocation.path) {
      this.logServer("trace", "definition", `module target uri=${document.uri} target=${moduleLocation.path}`);
      return {
        uri: pathToUri(moduleLocation.path),
        range: moduleLocation.range
      };
    }
    let queryLocation = null;
    try {
      queryLocation = await this.queryDefinitionLocation(document, documentIndex, params.position);
    } catch (error) {
      this.logServerError(`definition:${document.filePath || document.uri}`, error);
    }
    if (queryLocation && queryLocation.path) {
      this.logServer("trace", "definition", `query result uri=${document.uri} target=${queryLocation.path}`);
      return {
        uri: pathToUri(queryLocation.path),
        range: queryLocation.range
      };
    }
    const offset = positionToOffset(document.text, params.position);
    const target = findDefinitionLocation(
      documentIndex,
      offset,
      (importSymbol) => this.resolveModuleIndex(document, importSymbol)
    );
    if (!target || !target.path) {
      return null;
    }
    this.logServer("trace", "definition", `fallback local index uri=${document.uri} target=${target.path}`);
    return {
      uri: pathToUri(target.path),
      range: target.range
    };
  }

  async provideHover(params) {
    const document = this.getDocument(params.textDocument.uri);
    if (!document) {
      return null;
    }
    const documentIndex = this.getOrBuildIndex(document);
    let queryHover = null;
    try {
      queryHover = await this.queryHoverInfo(document, documentIndex, params.position);
    } catch (error) {
      this.logServerError(`hover:${document.filePath || document.uri}`, error);
    }
    if (queryHover) {
      this.logServer("trace", "hover", `query result uri=${document.uri}`);
      return queryHover;
    }
    const offset = positionToOffset(document.text, params.position);
    this.logServer("trace", "hover", `fallback local index uri=${document.uri}`);
    return findHoverInfo(
      documentIndex,
      offset,
      (importSymbol) => this.resolveModuleIndex(document, importSymbol)
    );
  }

  async provideSignatureHelp(params) {
    const document = this.getDocument(params.textDocument.uri);
    if (!document) {
      return null;
    }
    const documentIndex = this.getOrBuildIndex(document);
    let queryHelp = null;
    try {
      queryHelp = await this.querySignatureHelp(document, documentIndex, params.position);
    } catch (error) {
      this.logServerError(`signature-help:${document.filePath || document.uri}`, error);
    }
    if (queryHelp) {
      this.logServer("trace", "signature-help", `query result uri=${document.uri}`);
      return queryHelp;
    }
    const offset = positionToOffset(document.text, params.position);
    this.logServer("trace", "signature-help", `fallback local index uri=${document.uri}`);
    return findSignatureHelp(
      documentIndex,
      offset,
      (importSymbol) => this.resolveModuleIndex(document, importSymbol)
    );
  }

  async refreshDiagnostics(uri) {
    const document = this.getDocument(uri);
    if (!document) {
      return;
    }
    this.logServer("trace", "diagnostics", `refresh uri=${uri}`);
    if (!this.settings.enableDiagnostics) {
      this.logServer("trace", "diagnostics", `disabled uri=${uri}`);
      this.publishDiagnostics(uri, []);
      return;
    }
    if (this.settings.preferQueryBackend === false) {
      this.logServer("trace", "diagnostics", `query backend disabled uri=${uri}`);
      this.publishDiagnostics(uri, []);
      return;
    }
    const queryContext = resolveQueryContext(document, this.settings);
    if (!queryContext) {
      this.logServer("trace", "diagnostics", `no query context uri=${uri}`);
      this.publishDiagnostics(uri, []);
      return;
    }
    const version = document.version;
    let queryDiagnostics = null;
    try {
      queryDiagnostics = await this.queryDiagnostics(document);
    } catch (error) {
      this.logServerError(`query-diagnostics:${document.filePath || uri}`, error);
      return;
    }
    if (queryDiagnostics === null) {
      this.logServer("trace", "diagnostics", `query returned null uri=${uri}`);
      return;
    }
    const rawDiagnostics = queryDiagnostics || [];
    const latestDocument = this.getDocument(uri);
    if (!latestDocument || latestDocument.version !== version) {
      return;
    }
    const scopePaths = this.collectDiagnosticScopePaths(latestDocument, this.getOrBuildIndex(latestDocument));
    const diagnosticsByUri = new Map();
    const skippedUris = new Set();
    const ensureBucket = (targetUri) => {
      if (!diagnosticsByUri.has(targetUri)) {
        diagnosticsByUri.set(targetUri, []);
      }
      return diagnosticsByUri.get(targetUri);
    };

    ensureBucket(uri);

    for (const diagnostic of rawDiagnostics) {
      const targetPath = diagnostic.path ? path.normalize(diagnostic.path) : latestDocument.filePath;
      if (targetPath && scopePaths.size > 0 && !scopePaths.has(targetPath)) {
        this.logServer("trace", "diagnostics", `ignore unrelated query diagnostic uri=${uri} path=${targetPath}`);
        continue;
      }
      const targetUri = targetPath ? pathToUri(targetPath) : uri;
      if (!this.shouldPublishQueryDiagnosticsToUri(targetUri)) {
        skippedUris.add(targetUri);
        this.logServer("trace", "diagnostics", `skip stale query diagnostics for dirty document uri=${targetUri}`);
        continue;
      }
      ensureBucket(targetUri).push({
        range: diagnostic.range,
        severity: diagnostic.severity,
        source: diagnostic.source,
        message: diagnostic.message
      });
    }

    const nextPublishedUris = new Set();
    for (const [targetUri, diagnostics] of diagnosticsByUri.entries()) {
      nextPublishedUris.add(targetUri);
      this.logServer("trace", "diagnostics", `publish uri=${targetUri} count=${diagnostics.length}`);
      this.publishDiagnostics(targetUri, diagnostics);
    }

    for (const staleUri of Array.from(this.queryPublishedDiagnosticsUris)) {
      if (nextPublishedUris.has(staleUri) || skippedUris.has(staleUri)) {
        continue;
      }
      this.logServer("trace", "diagnostics", `clear stale uri=${staleUri}`);
      this.publishDiagnostics(staleUri, []);
    }

    this.queryPublishedDiagnosticsUris = nextPublishedUris;
  }

  refreshAllDiagnostics() {
    for (const uri of this.documents.keys()) {
      this.refreshDiagnosticsSafely(uri);
    }
  }

  publishDiagnostics(uri, diagnostics) {
    this.connection.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        diagnostics
      }
    });
  }
}

if (require.main === module) {
  const connection = new JsonRpcConnection(process.stdin, process.stdout);
  const server = new LonaLanguageServer(connection);
  connection.onMessage((message) => server.handleMessage(message));
}

module.exports = {
  JsonRpcConnection,
  LonaLanguageServer,
  pathToUri,
  uriToPath
};
