'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluate } = require('../claude-code/hook');

const TOOL_ROOT = path.join(__dirname, '..', '..');

function readPayload() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) return {};
  try {
    const payload = JSON.parse(raw);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  } catch {
    return {};
  }
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    permission: 'deny',
    user_message: reason,
    agent_message: reason,
  })}\n`);
}

function allow() {
  process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`);
}

function runStop(cwd) {
  const result = spawnSync(process.execPath, [
    path.join(TOOL_ROOT, 'bin', 'sdd.js'), 'check', '--stage', 'dev', '--repo', cwd,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
    process.stderr.write(`${text || 'sdd check failed'}\n`);
    process.exit(result.status || 1);
  }
}

function main() {
  const mode = process.argv[2] || 'shell';
  const payload = readPayload();
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  if (mode === 'stop') {
    runStop(cwd);
    return;
  }
  const command = typeof payload.command === 'string' ? payload.command : '';
  const result = evaluate(cwd, command);
  if (!result.allow) deny(result.reason || 'blocked');
  else allow();
}

if (require.main === module) main();

module.exports = { main };
