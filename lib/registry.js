'use strict';

const fs = require('fs');
const path = require('path');
const git = require('./git');
const { BlockedError } = require('./errors');
const { readJson, writeJson, toPosix } = require('./fsutil');

// The registry shares sdd-dev.local.json with the privacy settings; it only ever holds repo paths.
function registryFile(toolRoot) {
  return path.join(toolRoot, 'sdd-dev.local.json');
}

function readConfig(toolRoot) {
  const file = registryFile(toolRoot);
  if (!fs.existsSync(file)) return {};
  try {
    return readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse ${file}: ${error.message}`);
  }
}

function list(toolRoot) {
  const config = readConfig(toolRoot);
  return Array.isArray(config.installs) ? config.installs.map(String) : [];
}

function save(toolRoot, installs) {
  const config = readConfig(toolRoot);
  config.installs = [...new Set(installs)].sort();
  writeJson(registryFile(toolRoot), config);
}

function assertWritable(toolRoot) {
  const top = git.toplevel(toolRoot);
  if (!top) return;
  const rel = toPosix(path.relative(top, registryFile(toolRoot)));
  if (!git.isIgnored(top, rel)) {
    throw new BlockedError(`${rel} is not ignored by the tool's git; add it to the tool's .gitignore before sharing the tool`);
  }
}

function add(toolRoot, repoRoot) {
  assertWritable(toolRoot);
  save(toolRoot, [...list(toolRoot), repoRoot]);
}

function remove(toolRoot, ...repoRoots) {
  if (!fs.existsSync(toolRoot)) return;
  const current = list(toolRoot);
  const next = current.filter((root) => !repoRoots.includes(root));
  if (next.length !== current.length) save(toolRoot, next);
}

module.exports = { registryFile, list, add, remove, assertWritable };
