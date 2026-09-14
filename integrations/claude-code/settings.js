'use strict';

const fs = require('fs');
const path = require('path');
const { TOOL_ROOT } = require('../../lib/config');

const GATE_MATCHER = 'Edit|Write|NotebookEdit|Bash';
const PIPELINE_MATCHER = 'Bash';

function settingsPath(repoRoot) { return path.join(repoRoot, '.claude', 'settings.json'); }
function commandFor(repoRoot, kind) {
  const relative = path.relative(repoRoot, path.join(TOOL_ROOT, 'bin', 'devplan.js')).split(path.sep).join('/');
  return `node \"$CLAUDE_PROJECT_DIR/${relative}\" ${kind} --repo-root \"$CLAUDE_PROJECT_DIR\"`;
}
function ours(command) {
  return /(?:bin\/devplan\.js\"? (?:hook|pipeline-hook)|\.?devplan-v2\/scripts\/(?:gate-hook|pipeline-commit-hook)\.js)/.test(command || '');
}
function readSettings(repoRoot) {
  const file = settingsPath(repoRoot);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = `${file}.devplan-backup-${stamp}`;
  fs.copyFileSync(file, destination);
  return destination;
}
function removeOurs(settings) {
  const groups = (((settings || {}).hooks || {}).PreToolUse || []).map((group) => ({
    ...group,
    hooks: (group.hooks || []).filter((hook) => !ours(hook.command)),
  })).filter((group) => group.hooks.length > 0);
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = groups;
  return settings;
}
function writeSettings(repoRoot, settings) {
  const file = settingsPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
function install(repoRoot) {
  const file = settingsPath(repoRoot);
  const saved = backup(file);
  const settings = removeOurs(readSettings(repoRoot));
  settings.hooks.PreToolUse.push(
    { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: commandFor(repoRoot, 'hook') }] },
    { matcher: PIPELINE_MATCHER, hooks: [{ type: 'command', command: commandFor(repoRoot, 'pipeline-hook') }] }
  );
  writeSettings(repoRoot, settings);
  return { file, backup: saved };
}
function uninstall(repoRoot) {
  const file = settingsPath(repoRoot);
  const saved = backup(file);
  writeSettings(repoRoot, removeOurs(readSettings(repoRoot)));
  return { file, backup: saved };
}

module.exports = { settingsPath, commandFor, ours, readSettings, removeOurs, install, uninstall };
