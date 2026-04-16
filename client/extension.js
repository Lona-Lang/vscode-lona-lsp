"use strict";

const cp = require("child_process");
const path = require("path");
const vscode = require("vscode");

class JsonRpcClient {
  constructor(processHandle, outputChannel) {
    this.processHandle = processHandle;
    this.outputChannel = outputChannel;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.nextId = 1;

    this.processHandle.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });
    this.processHandle.stderr.on("data", (chunk) => {
      this.outputChannel.append(chunk.toString("utf8"));
    });
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  send(message) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
    this.processHandle.stdin.write(Buffer.concat([header, payload]));
  }

  sendNotification(method, params) {
    this.send({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  sendRequest(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    this.send({
      jsonrpc: "2.0",
      id,
      method,
      params
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
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
      const bodyStart = separator + 4;
      if (this.buffer.length < bodyStart + length) {
        return;
      }
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.slice(bodyStart + length);
      const message = JSON.parse(body);
      this.dispatch(message);
    }
  }

  dispatch(message) {
    if (typeof message.id !== "undefined") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Unknown LSP error"));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    const handler = this.notificationHandlers.get(message.method);
    if (handler) {
      handler(message.params || {});
    }
  }
}

function mapCompletionKind(kind) {
  switch (kind) {
    case 2:
      return vscode.CompletionItemKind.Method;
    case 3:
      return vscode.CompletionItemKind.Function;
    case 6:
      return vscode.CompletionItemKind.Variable;
    case 9:
      return vscode.CompletionItemKind.Module;
    case 10:
      return vscode.CompletionItemKind.Field;
    case 14:
      return vscode.CompletionItemKind.Keyword;
    case 22:
      return vscode.CompletionItemKind.Struct;
    default:
      return vscode.CompletionItemKind.Text;
  }
}

function toLspPosition(position) {
  return {
    line: position.line,
    character: position.character
  };
}

function primaryWorkspacePath() {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : null;
}

function resolvePathSetting(value) {
  if (!value) {
    return "";
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  const workspacePath = primaryWorkspacePath();
  return workspacePath ? path.join(workspacePath, value) : value;
}

function resolvePathListSetting(values) {
  return (values || []).map((value) => resolvePathSetting(value));
}

function readSettings() {
  const configuration = vscode.workspace.getConfiguration("lona.lsp");
  return {
    queryPath: configuration.get("queryPath", "lona-query"),
    rootPaths: resolvePathListSetting(configuration.get("rootPaths", [])),
    enableDiagnostics: configuration.get("enableDiagnostics", true),
    preferQueryBackend: configuration.get("preferQueryBackend", true)
  };
}

class LonaExtensionClient {
  constructor(context) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel("Lona Language Tools");
    this.diagnostics = vscode.languages.createDiagnosticCollection("lona");
    this.rpc = null;
    this.processHandle = null;
    this.subscriptions = [];
  }

  async start() {
    const serverPath = this.context.asAbsolutePath(path.join("server", "lsp-server.js"));
    this.processHandle = cp.spawn(process.execPath, [serverPath], {
      cwd: this.context.extensionPath,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.rpc = new JsonRpcClient(this.processHandle, this.outputChannel);
    this.rpc.onNotification("textDocument/publishDiagnostics", (params) => {
      const uri = vscode.Uri.parse(params.uri);
      const diagnostics = (params.diagnostics || []).map((diagnostic) => {
        const range = new vscode.Range(
          diagnostic.range.start.line,
          diagnostic.range.start.character,
          diagnostic.range.end.line,
          diagnostic.range.end.character
        );
        const item = new vscode.Diagnostic(range, diagnostic.message, vscode.DiagnosticSeverity.Error);
        item.source = diagnostic.source || "lona-query";
        return item;
      });
      this.diagnostics.set(uri, diagnostics);
    });

    const initializeParams = {
      processId: process.pid,
      rootUri: vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
        ? vscode.workspace.workspaceFolders[0].uri.toString()
        : null,
      workspaceFolders: (vscode.workspace.workspaceFolders || []).map((folder) => ({
        uri: folder.uri.toString(),
        name: folder.name
      })),
      initializationOptions: readSettings()
    };

    await this.rpc.sendRequest("initialize", initializeParams);
    this.rpc.sendNotification("initialized", {});

    this.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        [
          { language: "lona", scheme: "file" },
          { language: "lona", scheme: "untitled" }
        ],
        {
          provideCompletionItems: async (document, position) => {
            const items = await this.rpc.sendRequest("textDocument/completion", {
              textDocument: { uri: document.uri.toString() },
              position: toLspPosition(position)
            });
            return (items || []).map((item) => {
              const completion = new vscode.CompletionItem(item.label, mapCompletionKind(item.kind));
              completion.detail = item.detail || "";
              return completion;
            });
          }
        },
        "."
      ),
      vscode.languages.registerDefinitionProvider(
        [
          { language: "lona", scheme: "file" },
          { language: "lona", scheme: "untitled" }
        ],
        {
          provideDefinition: async (document, position) => {
            const location = await this.rpc.sendRequest("textDocument/definition", {
              textDocument: { uri: document.uri.toString() },
              position: toLspPosition(position)
            });
            if (!location || !location.uri || !location.range) {
              return null;
            }
            const uri = vscode.Uri.parse(location.uri);
            const range = new vscode.Range(
              location.range.start.line,
              location.range.start.character,
              location.range.end.line,
              location.range.end.character
            );
            return new vscode.Location(uri, range);
          }
        }
      ),
      vscode.languages.registerHoverProvider(
        [
          { language: "lona", scheme: "file" },
          { language: "lona", scheme: "untitled" }
        ],
        {
          provideHover: async (document, position) => {
            const hover = await this.rpc.sendRequest("textDocument/hover", {
              textDocument: { uri: document.uri.toString() },
              position: toLspPosition(position)
            });
            if (!hover || !Array.isArray(hover.contents) || hover.contents.length === 0) {
              return null;
            }
            const contents = hover.contents.map((item) => {
              if (item && item.language && item.value) {
                const markdown = new vscode.MarkdownString();
                markdown.appendCodeblock(item.value, item.language);
                return markdown;
              }
              const markdown = new vscode.MarkdownString();
              markdown.appendText(item && item.value ? item.value : String(item || ""));
              return markdown;
            });
            let range = undefined;
            if (hover.range) {
              range = new vscode.Range(
                hover.range.start.line,
                hover.range.start.character,
                hover.range.end.line,
                hover.range.end.character
              );
            }
            return new vscode.Hover(contents, range);
          }
        }
      ),
      vscode.workspace.onDidOpenTextDocument((document) => this.didOpenDocument(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.didChangeDocument(event)),
      vscode.workspace.onDidSaveTextDocument((document) => this.didSaveDocument(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.didCloseDocument(document)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("lona.lsp")) {
          this.rpc.sendNotification("workspace/didChangeConfiguration", {
            settings: readSettings()
          });
        }
      })
    );

    for (const document of vscode.workspace.textDocuments) {
      this.didOpenDocument(document);
    }
  }

  didOpenDocument(document) {
    if (document.languageId !== "lona") {
      return;
    }
    this.rpc.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: document.uri.toString(),
        languageId: document.languageId,
        version: document.version,
        text: document.getText()
      }
    });
  }

  didChangeDocument(event) {
    if (event.document.languageId !== "lona") {
      return;
    }
    this.rpc.sendNotification("textDocument/didChange", {
      textDocument: {
        uri: event.document.uri.toString(),
        version: event.document.version
      },
      contentChanges: [
        {
          text: event.document.getText()
        }
      ]
    });
  }

  didCloseDocument(document) {
    if (document.languageId !== "lona") {
      return;
    }
    this.diagnostics.delete(document.uri);
    this.rpc.sendNotification("textDocument/didClose", {
      textDocument: {
        uri: document.uri.toString()
      }
    });
  }

  didSaveDocument(document) {
    if (document.languageId !== "lona") {
      return;
    }
    this.rpc.sendNotification("textDocument/didSave", {
      textDocument: {
        uri: document.uri.toString()
      }
    });
  }

  async stop() {
    this.diagnostics.clear();
    this.diagnostics.dispose();
    vscode.Disposable.from(...this.subscriptions).dispose();
    if (this.rpc) {
      try {
        await this.rpc.sendRequest("shutdown", null);
      } catch {
        // Ignore shutdown failures on exit.
      }
      this.rpc.sendNotification("exit", null);
    }
    if (this.processHandle) {
      this.processHandle.kill();
    }
    this.outputChannel.dispose();
  }
}

let client = null;

async function activate(context) {
  client = new LonaExtensionClient(context);
  context.subscriptions.push({
    dispose() {
      if (client) {
        client.stop();
      }
    }
  });
  await client.start();
}

async function deactivate() {
  if (client) {
    await client.stop();
    client = null;
  }
}

module.exports = {
  activate,
  deactivate
};
