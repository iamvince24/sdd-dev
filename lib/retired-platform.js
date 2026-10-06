'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { assertSafeTarget, readUtf8 } = require('./safe-target');

const CURSOR_HOOK_MARKER = 'SDD_HOOK=1 ';
const CURSOR_HOOK_PATH = '/integrations/cursor/hook.js';

function present(root, relative) {
  const file = path.join(root, relative);
  // Check the complete path before existsSync: it follows links and misses dangling links.
  assertSafeTarget(root, file, relative);
  return fs.existsSync(file);
}

function cursorHooks(root) {
  const relative = '.cursor/hooks.json';
  if (!present(root, relative)) return false;
  let doc;
  try {
    doc = JSON.parse(readUtf8(path.join(root, relative), relative));
  } catch (error) {
    throw new BlockedError(`cannot inspect ${relative}: ${error.message}; repair it before changing sdd-dev`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) ||
      (doc.hooks != null && (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)))) {
    throw new BlockedError(`cannot inspect ${relative}: malformed hooks; repair it before changing sdd-dev`);
  }
  if (!doc.hooks) return false;
  for (const entries of Object.values(doc.hooks)) {
    if (!Array.isArray(entries)) throw new BlockedError(`cannot inspect ${relative}: malformed hook list; repair it before changing sdd-dev`);
    if (entries.some((entry) => entry && typeof entry.command === 'string' &&
      entry.command.startsWith(CURSOR_HOOK_MARKER) && entry.command.includes(CURSOR_HOOK_PATH))) return true;
  }
  return false;
}

function cursorRules(root) {
  const dir = '.cursor/rules';
  const abs = path.join(root, dir);
  assertSafeTarget(root, path.join(abs, '.sdd-inspection-probe'), dir);
  if (!fs.existsSync(abs)) return [];
  const found = [];
  for (const name of fs.readdirSync(abs)) {
    if (!/^sdd-[A-Za-z0-9_-]+\.mdc$/.test(name)) continue;
    const rel = `${dir}/${name}`;
    if (!present(root, rel)) continue;
    if (readUtf8(path.join(root, rel), rel).includes('<!-- sdd-rule')) found.push(rel);
  }
  return found;
}

function assertNoRetiredCursorInstall(root) {
  const found = [];
  for (const rel of ['.sdd-dev/instructions/cursor.json', '.sdd-dev/hook/cursor-hooks.backup.json']) {
    if (present(root, rel)) found.push(rel);
  }
  found.push(...cursorRules(root));
  if (cursorHooks(root)) found.push('.cursor/hooks.json (SDD Cursor hook)');
  if (!found.length) return;
  throw new BlockedError(
    `retired Cursor installation found in ${root}: ${found.join(', ')}. ` +
    'Review and remove only the SDD Cursor rule and SDD_HOOK=1 hook entries, then remove the Cursor instruction record and hook backup after checking their contents. ' +
    'Keep unrelated .cursor content. Do not blindly restore backups; Cursor instruction records do not store installed content hashes.'
  );
}

module.exports = { assertNoRetiredCursorInstall };
