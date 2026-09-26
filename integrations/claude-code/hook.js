'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { matchGrant } = require('../../lib/grants');
const { openInstalled, resolveRunId, readManifest } = require('../../lib/runstore');

const TOOL_ROOT = path.join(__dirname, '..', '..');

function tokensOf(command) {
  return (String(command).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function destructiveOp(command) {
  const tokens = tokensOf(command);
  const git = tokens.indexOf('git');
  if (git === -1) return null;
  const verb = tokens[git + 1];
  const rest = tokens.slice(git + 2);
  const flags = [];
  const args = [];
  for (const token of rest) {
    if (token === '--') continue;
    if (token.startsWith('-')) flags.push(token);
    else args.push(token);
  }
  if (verb === 'reset' && flags.includes('--hard')) return { op: 'reset_hard', scope: args[0] || 'HEAD' };
  if (verb !== 'push') return null;
  const forced = flags.some((flag) => (
    flag === '-f' || flag === '--force' || flag.startsWith('--force=')
    || flag === '--force-with-lease' || flag.startsWith('--force-with-lease=')
  ));
  if (!forced) return null;
  let spec = null;
  if (args.length >= 2) spec = args[1];
  else if (args.length === 1 && (args[0].includes(':') || args[0].includes('/'))) spec = args[0];
  if (!spec) return { op: 'force_push', scope: '' };
  const branch = spec.includes(':') ? spec.split(':').pop() : spec;
  return { op: 'force_push', scope: branch.replace(/^refs\/heads\//, '') };
}

function checkStatus(repoRoot) {
  const result = spawnSync(process.execPath, [path.join(TOOL_ROOT, 'bin', 'sdd.js'), 'check', '--repo', repoRoot], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function evaluate(repoRoot, command) {
  const action = destructiveOp(command);
  if (!action) return { allow: true };
  let paths;
  let id;
  try {
    paths = openInstalled(repoRoot).paths;
    id = resolveRunId(paths);
  } catch (error) {
    return { allow: false, reason: error.message };
  }
  if (!checkStatus(repoRoot)) return { allow: false, reason: 'sdd check failed' };
  const manifest = readManifest(paths, id);
  const grant = matchGrant(manifest.grants, action.op, action.scope);
  if (!grant) return { allow: false, reason: `no grant: ${action.op} ${action.scope}` };
  return { allow: true };
}

function commandFromPayload(raw) {
  if (!raw || !raw.trim()) return '';
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return '';
  }
  const input = payload && (payload.tool_input || payload.toolInput || payload);
  if (!input || typeof input !== 'object') return '';
  return typeof input.command === 'string' ? input.command : '';
}

function main() {
  const command = commandFromPayload(fs.readFileSync(0, 'utf8'));
  const result = evaluate(process.cwd(), command);
  if (!result.allow) {
    console.error(result.reason);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { destructiveOp, evaluate, commandFromPayload };
