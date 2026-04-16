"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const { buildDocumentIndex } = require("../server/lona-index");
const {
  buildQueryCompletionItems,
  closeAllQuerySessions,
  markQuerySessionDirty
} = require("../server/lona-query");

function writeFixtureFiles(rootDir) {
  const mathPath = path.join(rootDir, "math.lo");
  const mainPath = path.join(rootDir, "main.lo");

  fs.writeFileSync(
    mathPath,
    `struct Point {
    x i32
}

def fill(v i32) Point {
    ret Point(x = v)
}
`,
    "utf8"
  );

  fs.writeFileSync(
    mainPath,
    `import math

def run() i32 {
    var point math.Point = math.fill(40)
    ret point.x
}

ret run()
`,
    "utf8"
  );

  return { mainPath };
}

function offsetToPosition(text, offset) {
  const prefix = text.slice(0, offset);
  const lines = prefix.split(/\n/);
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}

function buildCompletionInput(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const document = {
    uri: `file://${filePath}`,
    filePath,
    text
  };
  const index = buildDocumentIndex(document);
  const offset = text.indexOf("point.x") + "point.".length;
  const position = offsetToPosition(text, offset);
  return { document, index, position };
}

async function timeCompletion(filePath, settings) {
  const { document, index, position } = buildCompletionInput(filePath);
  const startedAt = performance.now();
  const items = await buildQueryCompletionItems(document, index, position, settings, []);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(Array.isArray(items), "expected completion items");
  assert.ok(items.some((item) => item.label === "x"), "expected point.x member completion");
  return elapsedMs;
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lona-query-latency-"));
  const { mainPath } = writeFixtureFiles(workspace);
  const settings = {
    queryPath: process.env.LONA_QUERY_PATH || "lona-query",
    rootPaths: [workspace],
    preferQueryBackend: true
  };

  try {
    const startupMs = await timeCompletion(mainPath, settings);
    const warmMs = await timeCompletion(mainPath, settings);

    const updatedText = `${fs.readFileSync(mainPath, "utf8")}\n`;
    fs.writeFileSync(mainPath, updatedText, "utf8");
    markQuerySessionDirty(mainPath, settings);
    const changedMs = await timeCompletion(mainPath, settings);

    const result = {
      rootPaths: [workspace],
      startupMs: Math.round(startupMs),
      warmMs: Math.round(warmMs),
      changedMs: Math.round(changedMs)
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    closeAllQuerySessions();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
