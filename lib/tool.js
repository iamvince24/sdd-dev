'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { walk, copyFiles, readJson } = require('./fsutil');

const TOOL_ROOT = fs.realpathSync(path.join(__dirname, '..'));
const TOOL_ENTRIES = ['LICENSE', 'README.md', 'package.json', 'bin', 'integrations', 'lib', 'scripts', 'templates'];
const CONFIG_SCHEMA = 1;

function toolFiles(root) {
  const files = [];
  for (const entry of TOOL_ENTRIES) {
    const abs = path.join(root, entry);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) files.push(...walk(abs).map((file) => `${entry}/${file}`));
    else files.push(entry);
  }
  return files.sort();
}

function toolHash(root) {
  const hash = crypto.createHash('sha256');
  for (const file of toolFiles(root)) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

// The git SHA only counts when the tool is its own checkout, never the repo it is vendored into.
function toolVersion(root) {
  let pkg = null;
  try {
    pkg = readJson(path.join(root, 'package.json')).version || null;
  } catch (error) {
    pkg = null;
  }
  let sha = null;
  let dirty = null;
  if (git.toplevel(root) === root) {
    const head = git.run(root, ['rev-parse', 'HEAD']);
    if (head.status === 0) sha = head.stdout.trim();
    const status = git.run(root, ['status', '--porcelain', '--', ...TOOL_ENTRIES]);
    if (status.status === 0) dirty = status.stdout.trim() !== '';
  }
  return { package: pkg, git: sha, dirty };
}

function copyTool(srcRoot, dstRoot) {
  const staging = `${dstRoot}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  copyFiles(srcRoot, toolFiles(srcRoot), staging);
  fs.rmSync(dstRoot, { recursive: true, force: true });
  fs.renameSync(staging, dstRoot);
}

function shortHash(hash) {
  return typeof hash === 'string' ? hash.slice(0, 'sha256:'.length + 12) : String(hash);
}

function describeVersion(version) {
  if (!version) return 'unknown';
  const parts = [version.package || 'unversioned'];
  if (version.git) parts.push(`git ${version.git.slice(0, 7)}${version.dirty ? '+dirty' : ''}`);
  return parts.join(', ');
}

module.exports = {
  TOOL_ROOT,
  TOOL_ENTRIES,
  CONFIG_SCHEMA,
  toolFiles,
  toolHash,
  toolVersion,
  copyTool,
  shortHash,
  describeVersion,
};
