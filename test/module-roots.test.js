"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildModuleRoots } = require("../server/module-roots");

test("configured root paths are used as-is after normalization and deduplication", () => {
  const document = {
    filePath: "/workspace/app/src/feature.lo"
  };
  const settings = {
    rootPaths: ["/workspace/app", "/workspace/app", "/opt/lona/lib"]
  };

  assert.deepEqual(buildModuleRoots(document, settings), [
    "/workspace/app",
    "/opt/lona/lib"
  ]);
});

test("module roots use automatic root paths when rootPaths is empty", () => {
  const document = {
    filePath: "/workspace/app/src/feature.lo"
  };
  const settings = {
    rootPaths: [],
    autoRootPaths: ["/workspace/app"]
  };

  assert.deepEqual(buildModuleRoots(document, settings), [
    "/workspace/app"
  ]);
});

test("module roots are empty when neither rootPaths nor filePath is available", () => {
  assert.deepEqual(buildModuleRoots({}, { rootPaths: [] }), []);
});
