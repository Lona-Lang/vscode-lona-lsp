"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  buildCompletionItems,
  buildDocumentIndex,
  findDefinitionLocation,
  positionToOffset,
  resolveImportPath
} = require("../server/lona-index");

function buildResolver(modules) {
  return (importSymbol) => {
    const entry = modules.get(importSymbol.path);
    if (!entry) {
      return null;
    }
    return buildDocumentIndex({
      uri: `file://${entry.path}`,
      filePath: entry.path,
      text: entry.text
    });
  };
}

test("indexes structs and top-level functions", () => {
  const source = `
struct Point {
    x i32
    y i32
}

def add(a i32, b i32) i32 {
    ret a + b
}
`;
  const index = buildDocumentIndex({
    uri: "file:///tmp/main.lo",
    filePath: "/tmp/main.lo",
    text: source
  });

  assert.ok(index.structs.has("Point"));
  assert.ok(index.functions.has("add"));
  assert.equal(index.functions.get("add").returnType, "i32");
  assert.equal(index.structs.get("Point").fields.length, 2);
});

test("completes imported module symbols and struct members", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-lsp-test-"));
  const mathPath = path.join(workspace, "math.lo");
  const mainPath = path.join(workspace, "main.lo");
  const mathText = `
struct Point {
    x i32
    y i32
}

def fill(v i32) Point {
    ret Point(x = v, y = v)
}
`;
  fs.writeFileSync(mathPath, mathText, "utf8");

  const mainSource = `
import math

def run() i32 {
    var point math.Point = math.fill(40)
    math.
    point.
    ret 0
}
`;
  const modules = new Map([
    [
      "math",
      {
        path: mathPath,
        text: mathText
      }
    ]
  ]);

  const index = buildDocumentIndex({
    uri: `file://${mainPath}`,
    filePath: mainPath,
    text: mainSource
  });

  const mathOffset = positionToOffset(mainSource, { line: 5, character: 9 });
  const mathItems = buildCompletionItems(index, mathOffset, buildResolver(modules));
  assert.ok(mathItems.some((item) => item.label === "Point"));
  assert.ok(mathItems.some((item) => item.label === "fill"));

  const pointOffset = positionToOffset(mainSource, { line: 6, character: 10 });
  const pointItems = buildCompletionItems(index, pointOffset, buildResolver(modules));
  assert.ok(pointItems.some((item) => item.label === "x"));
  assert.ok(pointItems.some((item) => item.label === "y"));
});

test("completes locals visible before the cursor", () => {
  const source = `
def run() i32 {
    var count i32 = 1
    const label = "ok"
    cou
    ret count
}
`;
  const index = buildDocumentIndex({
    uri: "file:///tmp/main.lo",
    filePath: "/tmp/main.lo",
    text: source
  });
  const offset = positionToOffset(source, { line: 4, character: 7 });
  const items = buildCompletionItems(index, offset, () => null);
  assert.ok(items.some((item) => item.label === "count"));
  assert.ok(items.some((item) => item.label === "label"));
});

test("resolveImportPath prefers an existing include directory candidate", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-lsp-import-"));
  const currentDir = path.join(workspace, "src");
  const includeDir = path.join(workspace, "pkg");
  fs.mkdirSync(currentDir, { recursive: true });
  fs.mkdirSync(includeDir, { recursive: true });
  const includeFile = path.join(includeDir, "math.lo");
  fs.writeFileSync(includeFile, "def id(v i32) i32 { ret v }\n", "utf8");

  const resolved = resolveImportPath(path.join(currentDir, "main.lo"), "math", [includeDir]);
  assert.equal(resolved, includeFile);
});

test("finds local, import, function, type, and field definitions", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-lsp-definition-"));
  const mathPath = path.join(workspace, "math.lo");
  const mainPath = path.join(workspace, "main.lo");
  const mathText = `
struct Point {
    x i32
}

def fill(v i32) Point {
    ret Point(x = v)
}
`;
  fs.writeFileSync(mathPath, mathText, "utf8");

  const mainSource = `
import math

def run() i32 {
    var point math.Point = math.fill(40)
    ret point.x
}
`;

  const index = buildDocumentIndex({
    uri: `file://${mainPath}`,
    filePath: mainPath,
    text: mainSource
  });
  const resolver = buildResolver(new Map([
    [
      "math",
      {
        path: mathPath,
        text: mathText
      }
    ]
  ]));

  const pointOffset = positionToOffset(mainSource, { line: 4, character: 10 });
  const pointDefinition = findDefinitionLocation(index, pointOffset, resolver);
  assert.equal(pointDefinition.path, mainPath);
  assert.equal(pointDefinition.range.start.line, 4);
  assert.equal(pointDefinition.range.start.character, 8);

  const importOffset = positionToOffset(mainSource, { line: 1, character: 8 });
  const importDefinition = findDefinitionLocation(index, importOffset, resolver);
  assert.equal(importDefinition.path, mainPath);
  assert.equal(importDefinition.range.start.line, 1);
  assert.equal(importDefinition.range.start.character, 7);

  const fillOffset = positionToOffset(mainSource, { line: 4, character: 33 });
  const fillDefinition = findDefinitionLocation(index, fillOffset, resolver);
  assert.equal(fillDefinition.path, mathPath);
  assert.equal(fillDefinition.range.start.line, 5);
  assert.equal(fillDefinition.range.start.character, 4);

  const typeOffset = positionToOffset(mainSource, { line: 4, character: 19 });
  const typeDefinition = findDefinitionLocation(index, typeOffset, resolver);
  assert.equal(typeDefinition.path, mathPath);
  assert.equal(typeDefinition.range.start.line, 1);
  assert.equal(typeDefinition.range.start.character, 7);

  const fieldOffset = positionToOffset(mainSource, { line: 5, character: 14 });
  const fieldDefinition = findDefinitionLocation(index, fieldOffset, resolver);
  assert.equal(fieldDefinition.path, mathPath);
  assert.equal(fieldDefinition.range.start.line, 2);
  assert.equal(fieldDefinition.range.start.character, 4);
});
