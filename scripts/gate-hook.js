#!/usr/bin/env node
'use strict';

// Compatibility wrapper. New integrations call bin/devplan.js directly with an explicit repo root.
const path = require('path');
const { spawnSync } = require('child_process');

function repoRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').trim() : process.cwd();
}

const cli = path.resolve(__dirname, '..', 'bin', 'devplan.js');
const result = spawnSync(process.execPath, [cli, 'hook', '--repo-root', repoRoot(), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status === null ? 0 : result.status);
