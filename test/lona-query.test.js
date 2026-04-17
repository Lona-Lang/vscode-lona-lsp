"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { buildDocumentIndex } = require("../server/lona-index");
const {
  buildQueryCompletionItems,
  canUseQueryBackend,
  closeAllQuerySessions,
  findQueryDefinitionLocation,
  getActiveQuerySessionCount,
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

test("query backend uses automatic root paths when provided by the wrapper", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-current-"));
  const filePath = path.join(workspace, "main.lo");
  const text = "ret 0\n";
  fs.writeFileSync(filePath, text, "utf8");

  const document = {
    filePath,
    text
  };

  assert.equal(canUseQueryBackend(document, {
    preferQueryBackend: true,
    autoRootPaths: [workspace]
  }), true);
  assert.deepEqual(resolveQueryContext(document, {
    preferQueryBackend: true,
    autoRootPaths: [workspace]
  }), {
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

test("query diagnostics include imported module errors when opened from the root file", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-imported-diagnostics-"));
  const mainPath = path.join(workspace, "main.lo");
  const helperPath = path.join(workspace, "helper.lo");
  const mainText = `
import helper

def run() i32 {
    ret helper.value()
}
`;
  const helperText = `
def value() i32 {
    ret missing
}
`;
  fs.writeFileSync(mainPath, mainText, "utf8");
  fs.writeFileSync(helperPath, helperText, "utf8");

  const diagnostics = await runQueryDiagnostics({
    uri: `file://${mainPath}`,
    filePath: mainPath,
    text: mainText
  }, {
    queryPath: "lona-query",
    rootPaths: [workspace],
    preferQueryBackend: true
  });

  assert.ok(Array.isArray(diagnostics));
  assert.ok(diagnostics.some((item) => item.path === helperPath));

  closeAllQuerySessions();
});

test("query-backed completion auto-dereferences pointers and trait dyn receivers", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-receiver-"));
  const mainPath = path.join(workspace, "main.lo");
  const mainText = `
trait Hash {
    def hash() i32
}

struct Point {
    value i32
}

impl Hash for Point {
    def hash() i32 {
        ret self.value + 1
    }
}

def run() i32 {
    var point Point = Point(value = 41)
    var p Point* = &point
    var h Hash dyn = cast[Hash dyn](&point)
    ret p.value + h.hash()
}
`;
  fs.writeFileSync(mainPath, mainText, "utf8");

  const document = {
    uri: `file://${mainPath}`,
    filePath: mainPath,
    text: mainText
  };
  const index = buildDocumentIndex(document);
  const settings = {
    queryPath: "lona-query",
    rootPaths: [workspace],
    preferQueryBackend: true
  };

  const pointerItems = await buildQueryCompletionItems(document, index, { line: 19, character: 10 }, settings, []);
  const dynItems = await buildQueryCompletionItems(document, index, { line: 19, character: 20 }, settings, []);

  assert.ok(pointerItems.some((item) => item.label === "value"));
  assert.ok(dynItems.some((item) => item.label === "hash"));

  closeAllQuerySessions();
});

test("query-backed completion resolves applied generic struct receiver members", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-generic-receiver-"));
  const mainPath = path.join(workspace, "main.lo");
  const mainText = `
struct Vec[T] {
    len i32
    ptr T*
}

def run[T](value T) i32 {
    var tmp Vec[T] = Vec[T](len = 1, ptr = &value)
    ret tmp.len
}
`;
  fs.writeFileSync(mainPath, mainText, "utf8");

  const document = {
    uri: `file://${mainPath}`,
    filePath: mainPath,
    text: mainText
  };
  const index = buildDocumentIndex(document);
  const settings = {
    queryPath: "lona-query",
    rootPaths: [workspace],
    preferQueryBackend: true
  };

  const structItems = await buildQueryCompletionItems(document, index, { line: 8, character: 12 }, settings, []);

  assert.ok(structItems.some((item) => item.label === "len"));
  assert.ok(structItems.some((item) => item.label === "ptr"));

  closeAllQuerySessions();
});

test("query backend reuses a single session across files in the same root paths", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-session-"));
  const mainPath = path.join(workspace, "main.lo");
  const helperPath = path.join(workspace, "helper.lo");
  const mainText = `
import helper

def run() i32 {
    ret helper.id(1)
}
`;
  const helperText = `
def id(v i32) i32 {
    ret v
}
`;
  fs.writeFileSync(mainPath, mainText, "utf8");
  fs.writeFileSync(helperPath, helperText, "utf8");

  const settings = {
    queryPath: "lona-query",
    rootPaths: [workspace],
    preferQueryBackend: true
  };

  await runQueryDiagnostics({
    uri: `file://${mainPath}`,
    filePath: mainPath,
    text: mainText
  }, settings);
  assert.equal(getActiveQuerySessionCount(), 1);

  await runQueryDiagnostics({
    uri: `file://${helperPath}`,
    filePath: helperPath,
    text: helperText
  }, settings);
  assert.equal(getActiveQuerySessionCount(), 1);

  closeAllQuerySessions();
});
