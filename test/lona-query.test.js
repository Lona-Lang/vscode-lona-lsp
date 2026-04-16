"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { buildDocumentIndex } = require("../server/lona-index");
const {
  canUseQueryBackend,
  closeAllQuerySessions,
  findQueryDefinitionLocation,
  resolveQueryContext,
  runQueryDiagnostics
} = require("../server/lona-query");

test("query backend is enabled for saved files inside the configured root paths", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-root-"));
  const rootPath = path.join(workspace, "main.lo");
  const importedPath = path.join(workspace, "math.lo");
  const outsideWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-outside-"));
  const outsidePath = path.join(outsideWorkspace, "other.lo");
  const text = "ret 0\n";
  fs.writeFileSync(rootPath, text, "utf8");
  fs.writeFileSync(importedPath, text, "utf8");
  fs.writeFileSync(outsidePath, text, "utf8");

  const settings = {
    preferQueryBackend: true,
    rootPaths: [workspace]
  };

  const rootDocument = {
    filePath: rootPath,
    text
  };
  const importedDocument = {
    filePath: importedPath,
    text
  };
  const outsideDocument = {
    filePath: outsidePath,
    text
  };
  const dirtyRootDocument = {
    filePath: rootPath,
    text: "ret 1\n"
  };
  const dirtyImportedDocument = {
    filePath: importedPath,
    text: "ret 1\n"
  };

  assert.deepEqual(resolveQueryContext(rootDocument, settings), {
    rootPaths: [workspace],
    activeFilePath: rootPath,
    activeModule: "main",
    entryFilePath: rootPath,
    entryModule: "main"
  });
  assert.deepEqual(resolveQueryContext(importedDocument, settings), {
    rootPaths: [workspace],
    activeFilePath: importedPath,
    activeModule: "math",
    entryFilePath: importedPath,
    entryModule: "math"
  });
  assert.equal(canUseQueryBackend(rootDocument, settings), true);
  assert.equal(canUseQueryBackend(importedDocument, settings), true);
  assert.equal(canUseQueryBackend(outsideDocument, settings), false);
  assert.equal(canUseQueryBackend(dirtyRootDocument, settings), false);
  assert.equal(canUseQueryBackend(dirtyImportedDocument, settings), false);
});

test("query backend falls back to the current file when no root module is configured", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-current-"));
  const filePath = path.join(workspace, "main.lo");
  const text = "ret 0\n";
  fs.writeFileSync(filePath, text, "utf8");

  const document = {
    filePath,
    text
  };

  assert.equal(canUseQueryBackend(document, { preferQueryBackend: true }), true);
  assert.deepEqual(resolveQueryContext(document, { preferQueryBackend: true }), {
    rootPaths: [workspace],
    activeFilePath: filePath,
    activeModule: "main",
    entryFilePath: filePath,
    entryModule: "main"
  });
});

test("query-backed definition resolves imported field definitions", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-definition-"));
  const mainPath = path.join(workspace, "main.lo");
  const mathPath = path.join(workspace, "math.lo");
  const mathText = `
struct Point {
    x i32
}

def fill(v i32) Point {
    ret Point(x = v)
}
`;
  const mainText = `
import math

def run() i32 {
    var point math.Point = math.fill(40)
    ret point.x
}
`;
  fs.writeFileSync(mathPath, mathText, "utf8");
  fs.writeFileSync(mainPath, mainText, "utf8");

  const document = {
    uri: `file://${mainPath}`,
    filePath: mainPath,
    text: mainText
  };
  const index = buildDocumentIndex(document);
  const location = await findQueryDefinitionLocation(document, index, { line: 5, character: 14 }, {
    queryPath: "lona-query",
    rootPaths: [workspace],
    preferQueryBackend: true
  });

  assert.deepEqual(location, {
    path: mathPath,
    range: {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 5 }
    }
  });

  closeAllQuerySessions();
});

test("query diagnostics follow the active document within configured root paths", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-diagnostics-"));
  const mainPath = path.join(workspace, "main.lo");
  const mathPath = path.join(workspace, "math.lo");
  const mainText = `
import math

def run() i32 {
    ret math.value()
}
`;
  const mathText = `
def value() i32 {
    ret missing
}
`;
  fs.writeFileSync(mainPath, mainText, "utf8");
  fs.writeFileSync(mathPath, mathText, "utf8");

  const diagnostics = await runQueryDiagnostics({
    uri: `file://${mathPath}`,
    filePath: mathPath,
    text: mathText
  }, {
    queryPath: "lona-query",
    rootPaths: [workspace],
    preferQueryBackend: true
  });

  assert.ok(Array.isArray(diagnostics));
  assert.ok(diagnostics.length > 0);
  assert.equal(diagnostics[0].path, mathPath);
  assert.match(diagnostics[0].message, /undefined identifier/i);

  closeAllQuerySessions();
});
