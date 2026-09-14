'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { STATE_ROOT, projectContext } = require('./resolver');

const STATE_ENTRIES = ['active', 'done', 'refs', '.hook-log', '.pipeline-hook-log'];

function copyTree(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      if (name === '.DS_Store') continue;
      copyTree(path.join(source, name), path.join(target, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function manifest(root) {
  const rows = [];
  function walk(current, relative) {
    if (!fs.existsSync(current)) return;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) {
        if (name === '.DS_Store') continue;
        walk(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex');
    rows.push({ path: relative, sha256: hash, bytes: stat.size });
  }
  for (const entry of STATE_ENTRIES) walk(path.join(root, entry), entry);
  return rows;
}

function importState(repoId, sourceRoot) {
  const context = projectContext(repoId);
  const source = path.resolve(sourceRoot);
  if (!fs.existsSync(path.join(source, 'active')) || !fs.existsSync(path.join(source, 'refs'))) {
    const error = new Error(`Source is not a devplan state root: ${source}`);
    error.code = 'INVALID_STATE_SOURCE';
    throw error;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stagingParent = path.join(STATE_ROOT, '.staging');
  const staging = path.join(stagingParent, `${repoId}-${stamp}`);
  fs.mkdirSync(staging, { recursive: true });
  for (const entry of STATE_ENTRIES) {
    const from = path.join(source, entry);
    if (fs.existsSync(from)) copyTree(from, path.join(staging, entry));
  }
  const before = manifest(source);
  const after = manifest(staging);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const error = new Error('Copied state manifest does not match source');
    error.code = 'MANIFEST_MISMATCH';
    throw error;
  }
  let previous = null;
  if (fs.existsSync(context.projectStateRoot)) {
    const previousParent = path.join(STATE_ROOT, '.previous');
    fs.mkdirSync(previousParent, { recursive: true });
    previous = path.join(previousParent, `${repoId}-${stamp}`);
    fs.renameSync(context.projectStateRoot, previous);
  }
  fs.mkdirSync(path.dirname(context.projectStateRoot), { recursive: true });
  fs.renameSync(staging, context.projectStateRoot);
  const recordDir = path.join(STATE_ROOT, 'migration-records');
  fs.mkdirSync(recordDir, { recursive: true });
  const record = { importedAt: new Date().toISOString(), repoId, source, target: context.projectStateRoot, previous, manifest: after };
  fs.writeFileSync(path.join(recordDir, `${repoId}-${stamp}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}

module.exports = { STATE_ENTRIES, copyTree, manifest, importState };
