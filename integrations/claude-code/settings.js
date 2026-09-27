'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('../../lib/errors');
const { readJson, writeJson } = require('../../lib/fsutil');
const { openInstalled } = require('../../lib/runstore');
const { requireInstall, resolveToolRoot } = require('../../lib/install');

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
    const doc = readJson(file);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('settings must be an object');
    return doc;
  } catch (error) {
    throw new BlockedError(`cannot parse .claude/settings.json: ${error.message}`);
  }
}

function isSddHook(hook) {
  return !!(hook && typeof hook.command === 'string' && hook.command.includes(MARKER));
}

function hookCommand(repoRoot) {
  const { paths } = openInstalled(repoRoot);
  const install = requireInstall(paths);
  const toolRoot = resolveToolRoot(repoRoot, install.install);
  if (!toolRoot) throw new BlockedError('installed tool path is missing');
  const hook = path.join(toolRoot, 'integrations', 'claude-code', 'hook.js');
  if (!fs.existsSync(hook)) throw new BlockedError('claude-code hook is missing from the installed tool');
  return `${MARKER} ${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`;
}

const MATCHER = 'Bash|Edit|Write|MultiEdit';

function attach(groups, entry) {
  const list = Array.isArray(groups) ? groups : [];
  const owned = list.some((group) => Array.isArray(group.hooks) && group.hooks.some(isSddHook));
  if (!owned) list.push(entry);
  else if (entry.matcher) {
    for (const group of list) {
      if (group && Array.isArray(group.hooks) && group.hooks.some(isSddHook)) group.matcher = entry.matcher;
    }
  }
  return list;
}

function install(repoRoot) {
  const file = settingsPath(repoRoot);
  const backup = backupPath(repoRoot);
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file) : null;
  if (!fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    writeJson(`${backup}.json`, { existed, original_base64: original ? original.toString('base64') : null });
  }
  const settings = readSettings(file);
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  const command = hookCommand(repoRoot);
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
  if (!fs.existsSync(file)) return { removed: false };
  const settings = stripSdd(readSettings(file));
  writeJson(file, settings);
  return { removed: true, path: file };
}

module.exports = { MARKER, install, uninstall, isSddHook, backupPath };
