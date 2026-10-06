'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { continuation } = require('../../lib/hook-stop');
const { classify, collect, classifyPath } = require('../../lib/guard');
const { matchGrant } = require('../../lib/grants');
const { checkGrantSource } = require('../../lib/reviewer-source');
const { locateRun } = require('../../lib/hook-stop');
const { checkRun } = require('../../lib/check');
const { openInstalled, resolveRunId, readManifest, runDirectory } = require('../../lib/runstore');

const TOOL_ROOT = path.join(__dirname, '..', '..');

function contextFor(repoRoot, manifest) {
  return {
    cwd: repoRoot,
    repoRoot,
    writeRoots: (manifest && manifest.write_roots) || [],
  };
}

function denyGrant(op, scope) {
  return {
    allow: false,
    reason: `no grant: ${op} ${scope}; sdd grant add --op ${op} --scope ${scope} --source Q-n`,
  };
}

function decide(hits, manifest, runDir, runId) {
  const unparsed = hits.find((hit) => hit.op === 'unparsed');
  if (unparsed) return { allow: false, reason: 'cannot parse command' };
  const user = hits.find((hit) => hit.op === 'user_action');
  if (user) return { allow: false, reason: `user action is blocked: ${user.scope}` };
  if (hits.some((hit) => hit.op === 'git_commit')) return { allow: false, reason: 'blocked; use sdd commit' };
  const outside = hits.find((hit) => hit.op === 'outside_write');
  if (outside) return { allow: false, reason: `outside write_roots: ${outside.scope}` };
  for (const hit of hits) {
    const grant = matchGrant(manifest.grants, hit.op, hit.scope);
    if (!grant) return denyGrant(hit.op, hit.scope);
    const trust = checkGrantSource(grant);
    if (trust.status !== 'verified') return { allow: false, reason: `grant source unconfirmed: ${trust.reason}` };
  }
  const problems = checkRun(runDir, runId);
  if (problems.length) return { allow: false, reason: problems[0] };
  return { allow: true };
}

function loadRun(repoRoot) {
  const paths = openInstalled(repoRoot).paths;
  const id = resolveRunId(paths);
  return { paths, id, manifest: readManifest(paths, id), dir: runDirectory(paths, id) };
}

function evaluate(repoRoot, command) {
  try {
    const run = locateRun(repoRoot);
    if (run.kind === 'none') return { allow: true };
    if (run.kind === 'error') return { allow: false, reason: run.reason };
  } catch (error) { return { allow: false, reason: error.message }; }
  let loaded;
  try {
    loaded = loadRun(repoRoot);
  } catch (error) {
    return { allow: false, reason: error.message };
  }
  const hits = collect(command, contextFor(repoRoot, loaded.manifest), 0);
  if (!hits.length) return { allow: true };
  return decide(hits, loaded.manifest, loaded.dir, loaded.id);
}

function evaluatePath(repoRoot, filePath) {
  try {
    const run = locateRun(repoRoot);
    if (run.kind === 'none') return { allow: true };
    if (run.kind === 'error') return { allow: false, reason: run.reason };
  } catch (error) { return { allow: false, reason: error.message }; }
  let loaded;
  try {
    loaded = loadRun(repoRoot);
  } catch (error) {
    return { allow: false, reason: error.message };
  }
  const hit = classifyPath(filePath, contextFor(repoRoot, loaded.manifest));
  if (!hit) return { allow: true };
  return decide([hit], loaded.manifest, loaded.dir, loaded.id);
}

function destructiveOp(command) {
  const hit = classify(command, { cwd: process.cwd(), repoRoot: process.cwd(), writeRoots: [] });
  if (!hit || (hit.op !== 'reset_hard' && hit.op !== 'force_push')) return null;
  return hit;
}

function readPayload(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function commandFromPayload(raw) {
  const payload = readPayload(raw);
  const input = payload && (payload.tool_input || payload.toolInput || payload);
  if (!input || typeof input !== 'object') return '';
  return typeof input.command === 'string' ? input.command : '';
}

function fileFromPayload(payload) {
  const input = payload && (payload.tool_input || payload.toolInput);
  if (!input || typeof input !== 'object') return '';
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.filePath === 'string') return input.filePath;
  return '';
}

function main() {
  const payload = readPayload(fs.readFileSync(0, 'utf8'));
  const event = payload && (payload.hook_event_name || payload.hookEventName);
  if (event === 'Stop') {
    const decision = continuation(process.cwd(), payload || {}, 'claude-code');
    if (decision.continue) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: decision.reason })}\n`);
    else if (decision.reason) process.stderr.write(`${decision.reason}\n`);
    return;
  }
  const tool = payload && (payload.tool_name || payload.toolName);
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    const file = fileFromPayload(payload);
    const result = file ? evaluatePath(process.cwd(), file) : { allow: false, reason: 'cannot parse command' };
    if (!result.allow) {
      console.error(result.reason);
      process.exit(2);
    }
    return;
  }
  const command = commandFromPayload(JSON.stringify(payload || {}));
  const result = evaluate(process.cwd(), command);
  if (!result.allow) {
    console.error(result.reason);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { destructiveOp, evaluate, evaluatePath, commandFromPayload };
