"use strict";

const path = require("path");

function normalizePath(value) {
  return value ? path.normalize(value) : null;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean).map(normalizePath)));
}

function buildModuleRoots(document, settings) {
  const configuredRoots = unique((settings && settings.rootPaths) || []);
  if (configuredRoots.length > 0) {
    return configuredRoots;
  }
  if (document && document.filePath) {
    return [path.dirname(normalizePath(document.filePath))];
  }
  return [];
}

module.exports = {
  buildModuleRoots,
  normalizePath,
  unique
};
