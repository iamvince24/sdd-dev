'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { readJson, writeJson, realpathOrNull, toPosix, now } = require('./fsutil');
const { toolHash, toolVersion } = require('./tool');

function readInstall(paths) {
  if (!fs.existsSync(paths.installJson)) return null;
  let install;
  let local = null;
  try {
    install = readJson(paths.installJson);
    if (fs.existsSync(paths.installLocal)) local = readJson(paths.installLocal);
  } catch (error) {
    throw new BlockedError(`cannot parse install config: ${error.message}`);
  }
  return { install, local };
}

function requireInstall(paths) {
  const found = readInstall(paths);
  if (!found) throw new BlockedError('sdd-dev is not installed here; run `sdd init`');
  if (found.install.uninstalled_at) {
    throw new BlockedError(`sdd-dev was uninstalled at ${found.install.uninstalled_at}; run \`sdd init\` to reinstall`);
  }
  return found;
}

function writeInstall(paths, install, local) {
  writeJson(paths.installJson, install);
  if (local) writeJson(paths.installLocal, local);
}

// Version comes from the source checkout; for repo-local the hash is taken from the vendored copy.
function toolRecord(repoRoot, toolRoot, sourceRoot = toolRoot) {
  return {
    path: toPosix(path.relative(repoRoot, toolRoot)) || '.',
    hash: toolHash(toolRoot),
    version: toolVersion(sourceRoot),
  };
}

function localRecord(repoRoot, toolRoot) {
  return { repo_root: repoRoot, tool_root: toolRoot, resolved_at: now() };
}

function resolveToolRoot(repoRoot, install) {
  if (!install.tool || typeof install.tool.path !== 'string') return null;
  return realpathOrNull(path.resolve(repoRoot, install.tool.path));
}

module.exports = { readInstall, requireInstall, writeInstall, toolRecord, localRecord, resolveToolRoot };
