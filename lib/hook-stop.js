'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { computeCodebase, sameRef } = require('./codebase');
const { streamHash, reviewBindingProblems } = require('./review-binding');
const { walk } = require('./fsutil');
const { assertSafeTarget } = require('./safe-target');
const { acceptanceIds } = require('./verify');
const { currentPlanRevision } = require('./plan');
const { loadReview, unresolvedBlocking } = require('./review');
const { checkReviewSource } = require('./reviewer-source');

const TOOL_ROOT = path.join(__dirname, '..');
const PROGRESS_DIRS = ['sources', 'spec', 'plan'];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:^|_)(?:at|timestamp|date|time)$/.test(key) || ['started_at', 'finished_at', 'written_at', 'granted_at'].includes(key)) continue;
    out[key] = stable(item);
  }
  return out;
}

function stableBytes(file) {
  const bytes = fs.readFileSync(file);
  if (!file.endsWith('.json')) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return bytes;
    return Buffer.from(text.replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, '<timestamp>'));
  }
  try { return Buffer.from(JSON.stringify(stable(JSON.parse(bytes.toString('utf8'))))); }
  catch { return bytes; }
}

function validEvidence(repoRoot, runDir, manifest, ac) {
  const base = path.join(runDir, 'evidence', ac);
  const metaPath = path.join(base, 'meta.json');
  const outputPath = path.join(base, 'output.txt');
  if (!fs.existsSync(metaPath) || !fs.existsSync(outputPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (!meta || meta.ac !== ac || meta.status !== 'pass' || meta.stale === true || !meta.codebase_ref) return null;
  const workspace = (manifest.workspaces || []).find((item) => item.id === meta.workspace) || manifest.workspaces[0];
  if (!workspace) return null;
  const current = computeCodebase(repoRoot, workspace.path || '.');
  if (!sameRef(meta.codebase_ref, current.codebase_ref)) return null;
  if (!fs.statSync(outputPath).isFile()) return null;
  return { metaPath, outputPath };
}

function validReviews(repoRoot, runDir, manifest) {
  const revision = currentPlanRevision(runDir);
  if (!revision) return [];
  const files = [];
  for (const kind of ['plan-review', 'result-review']) {
    const review = loadReview(runDir, kind, revision);
    if (!review.exists || review.verdict !== 'READY' || unresolvedBlocking(review.findings).length) continue;
    if (kind === 'result-review' && reviewBindingProblems(repoRoot, runDir, review, manifest).length) continue;
    if (checkReviewSource(review).status !== 'verified') continue;
    files.push(path.join(runDir, review.rel));
    if (kind === 'result-review') files.push(path.join(runDir, review.rel.replace(/\.md$/, '.binding.json')));
  }
  return files;
}

function digestProgress(repoRoot, runDir) {
  const hash = crypto.createHash('sha256');
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  for (const dir of PROGRESS_DIRS) {
    const base = path.join(runDir, dir);
    if (!fs.existsSync(base)) continue;
    for (const rel of walk(base)) {
      const file = path.join(base, rel);
      hash.update(`${dir}/${rel}\0`);
      hash.update(stableBytes(file));
      hash.update('\0');
    }
  }
  for (const ac of acceptanceIds(runDir)) {
    let evidence;
    try { evidence = validEvidence(repoRoot, runDir, manifest, ac); } catch { evidence = null; }
    if (!evidence) continue;
    hash.update(`evidence/${ac}\0`);
    hash.update(stableBytes(evidence.metaPath));
    hash.update(stableBytes(evidence.outputPath));
  }
  for (const file of validReviews(repoRoot, runDir, manifest)) {
    hash.update(`${path.relative(runDir, file)}\0`);
    hash.update(stableBytes(file));
  }
  const resolved = (manifest.blocks || []).filter((block) => block && block.resolved_at)
    .map((block) => stable({ id: block.id, status: block.status, resolution: block.resolution, evidence: block.evidence }));
  hash.update(JSON.stringify(resolved));
  const codebase = computeCodebase(repoRoot).codebase_ref;
  hash.update(JSON.stringify(codebase));
  for (const unknown of codebase.unknown || []) hash.update(streamHash(path.join(repoRoot, unknown.path)));
  return hash.digest('hex');
}

function locateRun(repoRoot) {
  const base = path.join(repoRoot, '.sdd-dev');
  if (!fs.existsSync(base)) return { kind: 'none' };
  const runs = path.join(base, 'runs');
  if (!fs.existsSync(runs)) return { kind: 'none' };
  assertSafeTarget(repoRoot, path.join(runs, '_probe'), 'run directory');
  const entries = fs.readdirSync(runs, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  if (!entries.length) return { kind: 'none' };
  if (entries.some((entry) => !entry.isDirectory())) {
    return { kind: 'error', reason: 'SDD run cannot be selected unambiguously; inspect run directories' };
  }
  const selected = process.env.SDD_RUN_ID;
  if (selected && !entries.some((entry) => entry.name === selected)) {
    return { kind: 'error', reason: 'SDD_RUN_ID does not name an existing run' };
  }
  if (!selected && entries.length !== 1) {
    return { kind: 'error', reason: 'multiple SDD runs; set SDD_RUN_ID to the current run' };
  }
  const id = selected || entries[0].name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return { kind: 'error', reason: 'invalid SDD run id' };
  const runDir = path.join(runs, id);
  assertSafeTarget(repoRoot, path.join(runDir, 'manifest.json'), 'run manifest');
  if (!fs.existsSync(path.join(runDir, 'manifest.json'))) return { kind: 'error', reason: 'SDD run manifest is missing' };
  return { kind: 'run', id, runDir };
}

function nextDiagnostic(repoRoot, id) {
  const result = spawnSync(process.execPath, [path.join(TOOL_ROOT, 'bin', 'sdd.js'),
    'run', 'next', '--repo', repoRoot, '--run', id, '--json'], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return { kind: 'error', reason: (result.stderr || result.error?.message || 'run next failed').trim() };
  let doc;
  try { doc = JSON.parse(result.stdout); } catch { return { kind: 'error', reason: 'run next returned invalid JSON' }; }
  if (!doc || !['continue', 'wait_user', 'stop', 'run_done'].includes(doc.action)) {
    return { kind: 'error', reason: 'run next returned an unknown action' };
  }
  return { kind: 'ok', ...doc };
}

function statePath(runDir) { return path.join(runDir, 'hook', 'stop-state.json'); }

function continuation(repoRoot, payload = {}, platform = 'claude-code') {
  let run;
  try { run = locateRun(repoRoot); } catch (error) { return { continue: false, reason: `SDD run could not be checked: ${error.message}` }; }
  if (run.kind === 'none') return { continue: false, reason: '', noRun: true };
  if (run.kind === 'error') return { continue: false, reason: run.reason };
  const halt = (reason) => ({ continue: false, reason: `SDD run ${run.id} incomplete: ${reason}; resume: sdd run next --run ${run.id} --json after resolving the cause` });
  const next = nextDiagnostic(repoRoot, run.id);
  if (next.kind === 'error') return halt(`could not be checked: ${next.reason}`);
  if (next.action === 'run_done') return { continue: false, reason: `SDD run ${run.id} is ready to finalize: run sdd run done --run ${run.id}` };
  if (next.reason === 'already_done') return { continue: false, reason: `SDD run ${run.id} is already done` };
  if (next.action !== 'continue') return halt(next.reason || next.action);
  if (payload.user_abort === true || payload.user_abort === 'true' || payload.stop_reason === 'user_abort'
    || payload.status === 'aborted' || payload.status === 'error' || payload.error) {
    return halt('user interrupted the turn');
  }
  if (platform === 'cursor' && payload.status !== 'completed') {
    return halt('Cursor completion status is not confirmed');
  }
  if (platform === 'cursor' && payload.loop_count !== undefined
    && (!Number.isInteger(payload.loop_count) || payload.loop_count < 0)) {
    return halt('Cursor loop_count is invalid');
  }
  let fingerprint;
  try { fingerprint = digestProgress(repoRoot, run.runDir); } catch (error) {
    return halt(`progress could not be checked: ${error.message}`);
  }
  const file = statePath(run.runDir);
  let state = {};
  try {
    assertSafeTarget(repoRoot, file, 'hook state');
    if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid hook state');
    for (const item of Object.values(state)) {
      if (!item || typeof item.fingerprint !== 'string' || !Number.isInteger(item.count) || item.count < 0 || item.count > 2) {
        throw new Error('invalid hook state counter');
      }
    }
  } catch (error) { return halt(`SDD hook state cannot be trusted: ${error.message}`); }
  const session = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'anonymous';
  const sessionHash = crypto.createHash('sha256').update(session).digest('hex');
  const prior = state[sessionHash];
  const count = prior && prior.fingerprint === fingerprint ? prior.count || 0 : 0;
  if (platform === 'claude-code' && payload.stop_hook_active === true && !prior) {
    return halt('Stop hook is already active without a trusted continuation history');
  }
  if (count >= 2) return halt('same next step made no progress after two continuations');
  state[sessionHash] = { fingerprint, count: count + 1 };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assertSafeTarget(repoRoot, file, 'hook state');
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
  } catch (error) { return halt(`SDD hook state could not be saved: ${error.message}`); }
  const step = (next.next_steps || [])[0];
  return { continue: true, reason: `SDD run ${run.id} has authorized work: ${step?.message || next.reason}. Continue that work, then call sdd run next --run ${run.id} --json.` };
}

module.exports = { continuation, locateRun, digestProgress };
