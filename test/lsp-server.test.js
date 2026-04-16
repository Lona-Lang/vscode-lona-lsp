"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { LonaLanguageServer } = require("../server/lsp-server");

class FakeConnection {
  constructor() {
    this.messages = [];
  }

  onMessage() {}

  send(message) {
    this.messages.push(message);
  }
}

class CrashTolerantServer extends LonaLanguageServer {
  constructor(connection) {
    super(connection);
    this.queryCompletionError = null;
    this.queryDefinitionError = null;
    this.queryHoverError = null;
    this.querySignatureHelpError = null;
    this.queryDiagnosticsImpl = null;
    this.logged = [];
  }

  logServerError(scope, error) {
    this.logged.push({
      scope,
      message: error && error.message ? error.message : String(error)
    });
  }

  async queryCompletionItems() {
    if (this.queryCompletionError) {
      throw this.queryCompletionError;
    }
    return null;
  }

  async queryDefinitionLocation() {
    if (this.queryDefinitionError) {
      throw this.queryDefinitionError;
    }
    return null;
  }

  async queryHoverInfo() {
    if (this.queryHoverError) {
      throw this.queryHoverError;
    }
    return null;
  }

  async querySignatureHelp() {
    if (this.querySignatureHelpError) {
      throw this.querySignatureHelpError;
    }
    return null;
  }

  async queryDiagnostics(document) {
    if (this.queryDiagnosticsImpl) {
      return this.queryDiagnosticsImpl(document);
    }
    return null;
  }
}

function writeWorkspaceFile(prefix, fileName, text) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(workspace, fileName);
  fs.writeFileSync(filePath, text, "utf8");
  return { workspace, filePath };
}

function fileUri(filePath) {
  return `file://${filePath}`;
}

test("completion falls back to the local index when query throws", async () => {
  const { workspace, filePath } = writeWorkspaceFile("lona-lsp-completion-", "main.lo", `
def run() i32 {
    var count i32 = 1
    cou
    ret count
}
`);
  const connection = new FakeConnection();
  const server = new CrashTolerantServer(connection);
  server.settings = {
    ...server.settings,
    rootPaths: [workspace]
  };
  server.queryCompletionError = new Error("query crashed");
  server.openDocument({
    uri: fileUri(filePath),
    text: fs.readFileSync(filePath, "utf8"),
    version: 1
  });

  const items = await server.provideCompletion({
    textDocument: { uri: fileUri(filePath) },
    position: { line: 3, character: 7 }
  });

  assert.ok(items.some((item) => item.label === "count"));
  assert.ok(server.logged.some((entry) => entry.scope.startsWith("completion:")));
});

test("definition falls back to the local index when query throws", async () => {
  const { workspace, filePath } = writeWorkspaceFile("lona-lsp-definition-", "main.lo", `
def run() i32 {
    var count i32 = 1
    ret count
}
`);
  const connection = new FakeConnection();
  const server = new CrashTolerantServer(connection);
  server.settings = {
    ...server.settings,
    rootPaths: [workspace]
  };
  server.queryDefinitionError = new Error("query crashed");
  server.openDocument({
    uri: fileUri(filePath),
    text: fs.readFileSync(filePath, "utf8"),
    version: 1
  });

  const location = await server.provideDefinition({
    textDocument: { uri: fileUri(filePath) },
    position: { line: 2, character: 11 }
  });

  assert.equal(location.uri, fileUri(filePath));
  assert.equal(location.range.start.line, 2);
  assert.equal(location.range.start.character, 8);
  assert.ok(server.logged.some((entry) => entry.scope.startsWith("definition:")));
});

test("hover falls back to the local index when query throws", async () => {
  const { workspace, filePath } = writeWorkspaceFile("lona-lsp-hover-", "main.lo", `
struct Point {
    value i32
}

def run() i32 {
    var point Point = Point(value = 1)
    ret point.value
}
`);
  const connection = new FakeConnection();
  const server = new CrashTolerantServer(connection);
  server.settings = {
    ...server.settings,
    rootPaths: [workspace]
  };
  server.queryHoverError = new Error("query crashed");
  server.openDocument({
    uri: fileUri(filePath),
    text: fs.readFileSync(filePath, "utf8"),
    version: 1
  });

  const hover = await server.provideHover({
    textDocument: { uri: fileUri(filePath) },
    position: { line: 7, character: 15 }
  });

  assert.ok(hover);
  assert.ok(Array.isArray(hover.contents));
  assert.equal(hover.contents[0].value, "value i32");
  assert.ok(server.logged.some((entry) => entry.scope.startsWith("hover:")));
});

test("signature help falls back to the local index when query throws", async () => {
  const { workspace, filePath } = writeWorkspaceFile("lona-lsp-signature-", "main.lo", `
struct Point {
    value i32
    label str
}

def run() i32 {
    var point = Point(value = 1, )
    ret point.value
}
`);
  const connection = new FakeConnection();
  const server = new CrashTolerantServer(connection);
  server.settings = {
    ...server.settings,
    rootPaths: [workspace]
  };
  server.querySignatureHelpError = new Error("query crashed");
  server.openDocument({
    uri: fileUri(filePath),
    text: fs.readFileSync(filePath, "utf8"),
    version: 1
  });

  const help = await server.provideSignatureHelp({
    textDocument: { uri: fileUri(filePath) },
    position: { line: 7, character: 32 }
  });

  assert.ok(help);
  assert.equal(help.signatures[0].label, "Point(value i32, label str)");
  assert.equal(help.activeParameter, 1);
  assert.ok(server.logged.some((entry) => entry.scope.startsWith("signature-help:")));
});

test("diagnostics keep the last successful publish when query throws", async () => {
  const { workspace, filePath } = writeWorkspaceFile("lona-lsp-diagnostics-", "main.lo", "def run() i32 {\n    ret 0\n}\n");
  const connection = new FakeConnection();
  const server = new CrashTolerantServer(connection);
  let diagnosticsCallCount = 0;
  server.settings = {
    ...server.settings,
    rootPaths: [workspace]
  };
  server.queryDiagnosticsImpl = async () => {
    diagnosticsCallCount += 1;
    if (diagnosticsCallCount === 1) {
      return [{
        path: filePath,
        range: {
          start: { line: 1, character: 4 },
          end: { line: 1, character: 5 }
        },
        severity: 1,
        source: "lona-query",
        message: "first diagnostic"
      }];
    }
    throw new Error("query crashed");
  };

  await server.openDocument({
    uri: fileUri(filePath),
    text: fs.readFileSync(filePath, "utf8"),
    version: 1
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.messages.length, 1);
  assert.equal(connection.messages[0].params.diagnostics.length, 1);

  await server.refreshDiagnostics(fileUri(filePath));
  assert.equal(connection.messages.length, 1);
  assert.ok(server.logged.some((entry) => entry.scope.startsWith("query-diagnostics:")));
});

test("notification-side diagnostics failures are swallowed", async () => {
  const { workspace, filePath } = writeWorkspaceFile("lona-lsp-notify-", "main.lo", "def run() i32 {\n    ret 0\n}\n");
  const connection = new FakeConnection();
  const server = new CrashTolerantServer(connection);
  server.settings = {
    ...server.settings,
    rootPaths: [workspace]
  };
  server.queryDiagnosticsImpl = async () => {
    throw new Error("query crashed");
  };

  server.openDocument({
    uri: fileUri(filePath),
    text: fs.readFileSync(filePath, "utf8"),
    version: 1
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connection.messages.length, 0);
  assert.ok(server.logged.some((entry) => entry.scope.startsWith("query-diagnostics:")));
});
