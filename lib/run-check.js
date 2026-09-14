'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('./config');

function runScript(script, args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(TOOL_ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
  const code = result.status === null ? 3 : result.status;
  return {
    ok: code === 0,
    code,
    severity: code === 0 ? 'none' : code === 1 ? 'blocker' : 'structure',
    message: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    locations: [],
  };
}

module.exports = { runScript };
