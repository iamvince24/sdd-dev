'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

function run(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function runRaw(cwd, args) {
  return spawnSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
}

function toplevel(dir) {
  const result = run(dir, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) return null;
  return fs.realpathSync(result.stdout.trim());
}

function lsFiles(cwd, pathspec) {
  const result = run(cwd, ['ls-files', '-z', '--', pathspec]);
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean);
}

// --no-index checks the rules themselves, even for paths that are already tracked.
function isIgnored(cwd, rel) {
  return run(cwd, ['check-ignore', '-q', '--no-index', '--', rel]).status === 0;
}

module.exports = { run, runRaw, toplevel, lsFiles, isIgnored };
