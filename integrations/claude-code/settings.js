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

function settingsPath(repoRoot) {
  return path.join(repoRoot, '.claude', 'settings.json');
}

function backupPath(repoRoot) {
  return path.join(repoRoot, '.sdd-dev', 'hook', 'claude-settings.backup');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const doc = JSON.parse(readUtf8(file, '.claude/settings.json'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('settings must be an object');
    return doc;
  } catch (error) {
    throw new BlockedError(`cannot parse .claude/settings.json: ${error.message}`);
  }
}

function isSddHook(hook) {
  return !!(hook && typeof hook.command === 'string' && hook.command.startsWith(`${MARKER} `)
    && hook.command.includes('/integrations/claude-code/hook.js'));
}

function hookCommand(repoRoot) {
  const { paths } = openInstalled(repoRoot);
  const install = requireInstall(paths);
  const toolRoot = resolveToolRoot(repoRoot, install.install);
  if (!toolRoot) throw new BlockedError('installed tool path is missing');
  const hook = path.join(toolRoot, 'integrations', 'claude-code', 'hook.js');
  if (!fs.existsSync(hook)) throw new BlockedError('claude-code hook is missing from the installed tool');
  return `${MARKER} ${shellQuote(process.execPath)} ${shellQuote(hook)}`;
}

const MATCHER = 'Bash|Edit|Write|MultiEdit';

function attach(groups, entry) {
  const list = Array.isArray(groups) ? groups : [];
  const kept = stripEvent(list);
  kept.push(entry);
  return kept;
}

function install(repoRoot) {
  const file = settingsPath(repoRoot);
  const backup = backupPath(repoRoot);
  assertSafeTarget(repoRoot, file, '.claude/settings.json');
  assertSafeTarget(repoRoot, `${backup}.json`, 'claude hook backup');
  const settings = readSettings(file);
  const command = hookCommand(repoRoot);
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file) : null;
  if (!fs.existsSync(`${backup}.json`)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    writeJson(`${backup}.json`, { existed, original_base64: original ? original.toString('base64') : null });
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  settings.hooks.PreToolUse = attach(settings.hooks.PreToolUse, {
    matcher: MATCHER,
    hooks: [{ type: 'command', command }],
  });
  settings.hooks.Stop = attach(settings.hooks.Stop, {
    hooks: [{ type: 'command', command }],
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, settings);
  return { path: file, command };
}

function stripEvent(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => {
      if (!group || !Array.isArray(group.hooks)) return group;
      return { ...group, hooks: group.hooks.filter((hook) => !isSddHook(hook)) };
    })
    .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length);
}

function stripSdd(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return settings;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const left = stripEvent(settings.hooks[event]);
    if (left.length) settings.hooks[event] = left;
    else delete settings.hooks[event];
  }
  return settings;
}

function uninstall(repoRoot) {
  const file = settingsPath(repoRoot);
  assertSafeTarget(repoRoot, file, '.claude/settings.json');
  if (!fs.existsSync(file)) return { removed: false };
  const settings = stripSdd(readSettings(file));
  writeJson(file, settings);
  return { removed: true, path: file };
}

module.exports = { MARKER, install, uninstall, isSddHook, backupPath };
