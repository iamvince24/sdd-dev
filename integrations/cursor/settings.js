'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('../../lib/errors');
const { readJson, writeJson } = require('../../lib/fsutil');
const { openInstalled } = require('../../lib/runstore');
const { requireInstall, resolveToolRoot } = require('../../lib/install');
const { assertSafeTarget, readUtf8 } = require('../../lib/safe-target');
const { shellQuote } = require('../../lib/shell-quote');

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
  return `${MARKER} ${shellQuote(process.execPath)} ${shellQuote(hook)} ${shellQuote(mode)}`;
}

function readHooks(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const doc = JSON.parse(readUtf8(file, '.cursor/hooks.json'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('hooks.json must be an object');
    return doc;
  } catch (error) {
    throw new BlockedError(`cannot parse .cursor/hooks.json: ${error.message}`);
  }
}

function owns(entry) {
  return !!(entry && typeof entry.command === 'string' && entry.command.startsWith(`${MARKER} `)
    && entry.command.includes('/integrations/cursor/hook.js'));
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
  assertSafeTarget(repoRoot, file, '.cursor/hooks.json');
  assertSafeTarget(repoRoot, `${backup}.json`, 'cursor hook backup');
  const doc = readHooks(file);
  const shellCommand = hookCommand(repoRoot, 'shell');
  const stopCommand = hookCommand(repoRoot, 'stop');
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file) : null;
  if (!fs.existsSync(`${backup}.json`)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    writeJson(`${backup}.json`, { existed, original_base64: original ? original.toString('base64') : null });
  }
  if (!doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) doc.hooks = {};
  const shell = ensureList(doc.hooks, 'beforeShellExecution', shellCommand);
  const stop = ensureList(doc.hooks, 'stop', stopCommand);
  if (shell || stop) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, doc);
  }
  return { path: file };
}

function uninstall(repoRoot) {
  const file = hooksPath(repoRoot);
  assertSafeTarget(repoRoot, file, '.cursor/hooks.json');
  if (!fs.existsSync(file)) return { removed: false };
  const doc = readHooks(file);
  if (!doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) return { removed: false };
  let removed = false;
  for (const name of Object.keys(doc.hooks)) {
    const entries = doc.hooks[name];
    if (!Array.isArray(entries)) continue;
    const left = entries.filter((entry) => !owns(entry));
    if (left.length !== entries.length) removed = true;
    if (left.length) doc.hooks[name] = left;
    else delete doc.hooks[name];
  }
  if (removed) writeJson(file, doc);
  return { removed, path: file };
}

module.exports = { MARKER, install, uninstall, backupPath };
