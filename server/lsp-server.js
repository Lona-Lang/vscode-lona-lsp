"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

const {
  buildCompletionItems,
  buildDocumentIndex,
  findDefinitionLocation,
  positionToOffset,
  resolveImportPath
} = require("./lona-index");
const {
  buildQueryCompletionItems,
  closeAllQuerySessions,
  findQueryDefinitionLocation,
  markQuerySessionDirty,
  resolveQueryContext,
  runQueryDiagnostics
} = require("./lona-query");
const { buildModuleRoots } = require("./module-roots");

const QUERY_IDLE_RELOAD_MS = 500;

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
      enableDiagnostics: true,
      queryPath: "lona-query",
      preferQueryBackend: true
    };
    this.moduleCache = new Map();
    this.queryIdleTimers = new Map();
    this.shutdownRequested = false;
  }

  logServerError(scope, error) {
    const message = error && error.stack ? error.stack : String(error);
    try {
      process.stderr.write(`[lona-lsp] ${scope}: ${message}\n`);
    } catch {
      // Ignore logging failures.
    }
  }

  handleMessage(message) {
    if (typeof message.id !== "undefined" && message.method) {
      Promise.resolve(this.handleRequest(message.method, message.params || {}))
        .then((result) => {
          this.connection.send({
            jsonrpc: "2.0",
            id: message.id,
            result
          });
        })
        .catch((error) => {
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
      Promise.resolve()
        .then(() => this.handleNotification(message.method, message.params || {}))
        .catch((error) => {
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
    return {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: ["."]
        },
        definitionProvider: true
      }
    };
  }

  openDocument(textDocument) {
    this.documents.set(textDocument.uri, this.createDocumentState(textDocument));
    this.invalidateModuleForDocument(textDocument.uri);
    this.refreshDiagnosticsSafely(textDocument.uri);
  }

  changeDocument(params) {
    const existing = this.documents.get(params.textDocument.uri);
    if (!existing || !params.contentChanges.length) {
      return;
    }
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
    this.clearQueryIdleReload(textDocument.uri);
    if (this.settings.preferQueryBackend !== false && resolveQueryContext(existing, this.settings)) {
      markQuerySessionDirty(existing, this.settings);
    }
    this.refreshDiagnosticsSafely(textDocument.uri);
  }

  closeDocument(textDocument) {
    this.clearQueryIdleReload(textDocument.uri);
    this.documents.delete(textDocument.uri);
    this.invalidateModuleForDocument(textDocument.uri);
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
    const timer = setTimeout(() => {
      this.queryIdleTimers.delete(uri);
      const latest = this.getDocument(uri);
      if (!latest || this.settings.preferQueryBackend === false || !resolveQueryContext(latest, this.settings)) {
        return;
      }
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

  async queryDiagnostics(document) {
    return runQueryDiagnostics(document, this.settings);
  }

  resolveModuleIndex(currentDocument, importSymbol) {
    const currentIndex = this.getOrBuildIndex(currentDocument);
    const resolvedPath = resolveImportPath(
      currentDocument.filePath,
      importSymbol.path,
      buildModuleRoots(currentDocument, this.settings)
    );
    if (!resolvedPath) {
      return null;
    }
    return this.loadModuleIndex(resolvedPath);
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
      return queryItems;
    }
    const offset = positionToOffset(document.text, params.position);
    return buildCompletionItems(documentIndex, offset, (importSymbol) => this.resolveModuleIndex(document, importSymbol));
  }

  async provideDefinition(params) {
    const document = this.getDocument(params.textDocument.uri);
    if (!document) {
      return null;
    }
    const documentIndex = this.getOrBuildIndex(document);
    let queryLocation = null;
    try {
      queryLocation = await this.queryDefinitionLocation(document, documentIndex, params.position);
    } catch (error) {
      this.logServerError(`definition:${document.filePath || document.uri}`, error);
    }
    if (queryLocation && queryLocation.path) {
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
    return {
      uri: pathToUri(target.path),
      range: target.range
    };
  }

  async refreshDiagnostics(uri) {
    const document = this.getDocument(uri);
    if (!document) {
      return;
    }
    if (!this.settings.enableDiagnostics) {
      this.publishDiagnostics(uri, []);
      return;
    }
    if (this.settings.preferQueryBackend === false) {
      this.publishDiagnostics(uri, []);
      return;
    }
    const queryContext = resolveQueryContext(document, this.settings);
    if (!queryContext) {
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
      return;
    }
    const rawDiagnostics = queryDiagnostics || [];
    const latestDocument = this.getDocument(uri);
    if (!latestDocument || latestDocument.version !== version) {
      return;
    }
    const relevantDiagnostics = rawDiagnostics.filter((diagnostic) => {
      if (!diagnostic.path) {
        return true;
      }
      if (latestDocument.filePath && diagnostic.path === latestDocument.filePath) {
        return true;
      }
      return false;
    }).map((diagnostic) => ({
      range: diagnostic.range,
      severity: diagnostic.severity,
      source: diagnostic.source,
      message: diagnostic.message
    }));
    this.publishDiagnostics(uri, relevantDiagnostics);
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
