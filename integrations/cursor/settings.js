'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('../../lib/errors');
const { readJson, writeJson } = require('../../lib/fsutil');
const { openInstalled } = require('../../lib/runstore');
const { requireInstall, resolveToolRoot } = require('../../lib/install');

const MARKER = 'SDD_HOOK=1';

function hooksPath(repoRoot) {
  return path.join(repoRoot, '.cursor', 'hooks.json');
}

function backupPath(repoRoot) {
  return path.join(repoRoot, '.sdd-dev', 'hook', 'cursor-hooks.backup');
}

function hookCommand(repoRoot, mode) {
  const { paths } = openInstalled(repoRoot);
  const install = requireInstall(paths);
  const toolRoot = resolveToolRoot(repoRoot, install.install);
  if (!toolRoot) throw new BlockedError('installed tool path is missing');
  const hook = path.join(toolRoot, 'integrations', 'cursor', 'hook.js');
  if (!fs.existsSync(hook)) throw new BlockedError('cursor hook is missing from the installed tool');
  return `${MARKER} ${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} ${mode}`;
}

function readHooks(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const doc = readJson(file);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('hooks.json must be an object');
    return doc;
  } catch (error) {
    throw new BlockedError(`cannot parse .cursor/hooks.json: ${error.message}`);
  }
}

function owns(entry) {
  return !!(entry && typeof entry.command === 'string' && entry.command.includes(MARKER));
}

function ensureList(hooks, name, command) {
  if (hooks[name] == null) hooks[name] = [];
  if (!Array.isArray(hooks[name])) {
    throw new BlockedError(`.cursor/hooks.json ${name} must be a list`);
  }
  if (hooks[name].some(owns)) return false;
  hooks[name].push({ command });
  return true;
}

function install(repoRoot) {
  const file = hooksPath(repoRoot);
  const backup = backupPath(repoRoot);
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file) : null;
  if (!fs.existsSync(`${backup}.json`)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    writeJson(`${backup}.json`, { existed, original_base64: original ? original.toString('base64') : null });
  }
  const doc = readHooks(file);
  if (!doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) doc.hooks = {};
  const shell = ensureList(doc.hooks, 'beforeShellExecution', hookCommand(repoRoot, 'shell'));
  const stop = ensureList(doc.hooks, 'stop', hookCommand(repoRoot, 'stop'));
  if (shell || stop) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, doc);
  }
  return { path: file };
}

function uninstall(repoRoot) {
  const file = hooksPath(repoRoot);
  const backupFile = `${backupPath(repoRoot)}.json`;
  if (!fs.existsSync(backupFile)) return { removed: false };
  const backup = readJson(backupFile);
  if (backup.existed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(backup.original_base64 || '', 'base64'));
  } else if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
  return { removed: true, path: file };
}

module.exports = { MARKER, install, uninstall, backupPath };
