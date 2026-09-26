#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const TOOL_ROOT = path.join(__dirname, '..');
const USAGE = 'Usage: sdd <privacy-check>';

function runScript(script, args) {
  const result = spawnSync(process.execPath, [path.join(TOOL_ROOT, 'scripts', script), ...args], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`sdd: ${result.error.message}`);
    return 3;
  }
  return result.status === null ? 1 : result.status;
}

const command = process.argv[2] || '';

switch (command) {
  case 'privacy-check':
    process.exit(runScript('privacy-check.js', [TOOL_ROOT]));
    break;
  default:
    console.error(USAGE);
    process.exit(3);
}
