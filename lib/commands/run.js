'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { contentHash } = require('../hash');
const { packRun } = require('../pack-run');
const { refresh } = require('../drift');
const { now } = require('../fsutil');
const { syncProfileOnStart } = require('../profile');
const { captureBaselineEvidence, writeReport } = require('../verify');
const { applyToManifest } = require('../capabilities');
const { PLATFORMS } = require('../instructions');
const { markDone } = require('../done');
const { changeRoute, recomputeAuthority } = require('../route');
const { setStatus } = require('../manifest');
const {
  ROUTES,
  openInstalled,
  runDirectory,
  resolveRunId,
  readManifest,
  writeManifest,
  newRunId,
  ensureWorkspace,
  resolveSource,
  nextSourceName,
  modifiersFrom,
  buildManifest,
} = require('../runstore');

function readStdin(hint) {
  if (process.stdin.isTTY) throw new UsageError(`stdin is a terminal; ${hint}`);
  return fs.readFileSync(0);
}

function printDrift(label, id, drift) {
  console.log(`${label} ${id}`);
  for (const workspace of drift.workspaces) {
    console.log(`workspace ${workspace.id}`);
    console.log(`baseline head ${workspace.baseline_head || 'none'}`);
    console.log(`current head ${workspace.current_head || 'none'}`);
    if (workspace.baseline_worktree_hash !== workspace.current_worktree_hash) {
      console.log(`baseline worktree ${workspace.baseline_worktree_hash || 'empty'}`);
      console.log(`current worktree ${workspace.current_worktree_hash || 'empty'}`);
    }
  }
  for (const source of drift.sources) {
    console.log(`source ${source.path}`);
    console.log(`  was ${source.previous}`);
    console.log(`  now ${source.current}`);
  }
  for (const rel of drift.revisions) console.log(`revision ${rel}`);
  for (const rel of drift.approvals) console.log(`approval ${rel}`);
  const stale = drift.stale_evidence.length ? drift.stale_evidence.join(', ') : 'none';
  console.log(`stale evidence: ${stale}`);
}

function recordDrift(paths, repoRoot, id, manifest, command, includeSources) {
  const drift = refresh(repoRoot, runDirectory(paths, id), manifest, { includeSources });
  manifest.drift = { at: now(), command, ...drift };
  writeManifest(paths, id, manifest);
  printDrift(command, id, manifest.drift);
}

function start(argv) {
  const args = parseArgs(argv, {
    values: ['workspace', 'route', 'repo', 'platform'],
    flags: ['source-stdin', 'fast-lane', 'cross-check', 'no-delegation', 'plan-only'],
    lists: ['source'],
  });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { repo, paths } = openInstalled(args.values.repo);
  if (!args.values.workspace) throw new UsageError('--workspace is required');
  if (!args.values.route) throw new UsageError('--route is required');
  const route = ROUTES[args.values.route];
  if (!route) {
    throw new UsageError('--route must be direct, selected_advisors, full_pipeline, ag, or agentflow');
  }
  if (args.values.platform && !PLATFORMS.includes(args.values.platform)) {
    throw new UsageError(`--platform must be ${PLATFORMS.join(', ')}`);
  }
  const files = args.lists.source || [];
  if (!files.length && !args.flags['source-stdin']) throw new UsageError('--source or --source-stdin is required');

  const workspace = ensureWorkspace(paths, repo, args.values.workspace);
  syncProfileOnStart(paths, repo, workspace.id);
  const id = newRunId(paths.runs);
  const dir = runDirectory(paths, id);
  fs.mkdirSync(dir, { recursive: true });
  const sources = [];
  for (const file of files) {
    const resolved = resolveSource(repo.root, file);
    sources.push({ path: resolved.rel, id: contentHash(fs.readFileSync(resolved.abs)), origin: 'file' });
  }
  if (args.flags['source-stdin']) {
    const bytes = readStdin('pass --source or a pipe');
    const rel = nextSourceName(dir);
    fs.writeFileSync(path.join(dir, rel), bytes);
    sources.push({ path: rel, id: contentHash(bytes), origin: 'stdin' });
  }
  const reason = route === args.values.route ? 'run start' : `run start via ${args.values.route}`;
  const modifiers = modifiersFrom({
    fast_lane: args.flags['fast-lane'] === true,
    cross_check: args.flags['cross-check'] === true,
    no_delegation: args.flags['no-delegation'] === true,
    plan_only: args.flags['plan-only'] === true,
  });
  const manifest = buildManifest({ id, route, reason, repo, paths, workspace, sources, modifiers });
  applyToManifest(manifest, paths.config, dir, args.values.platform);
  writeManifest(paths, id, manifest);
  const baseline = manifest.workspaces[0].baseline;
  console.log(`run ${id}`);
  console.log(`route ${route}`);
  console.log(`modifiers fast_lane=${modifiers.fast_lane} cross_check=${modifiers.cross_check} no_delegation=${modifiers.no_delegation} plan_only=${modifiers.plan_only}`);
  for (const source of sources) console.log(`source ${source.path} ${source.id}`);
  console.log(`workspace ${workspace.id} head ${baseline.codebase_ref.head || 'none'} dirty ${baseline.dirty.length}`);
  captureBaselineEvidence(repo.root, dir, manifest, paths);
  return 0;
}

function baseline(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  recordDrift(paths, repo.root, id, readManifest(paths, id), 'baseline', false);
  return 0;
}

function resume(argv) {
  const args = parseArgs(argv, { values: ['repo'] });
  if (args._.length !== 1) throw new UsageError('usage: sdd run resume <run_id>');
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args._[0]);
  const manifest = readManifest(paths, id);
  applyToManifest(manifest, paths.config, runDirectory(paths, id));
  recordDrift(paths, repo.root, id, manifest, 'resume', true);
  return 0;
}

function exportRun(argv) {
  const args = parseArgs(argv, { values: ['out', 'repo'] });
  if (args._.length !== 1) throw new UsageError('usage: sdd run export <run_id> --out <path>');
  if (!args.values.out) throw new UsageError('--out is required');
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args._[0]);
  const packed = packRun(runDirectory(paths, id));
  const out = path.resolve(args.values.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, packed);
  console.log(`export ${id} ${out}`);
  return 0;
}

function boolOption(name, raw) {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new UsageError(`--${name} must be true or false`);
}

function setRoute(argv) {
  const args = parseArgs(argv, {
    values: ['route', 'reason', 'by', 'run', 'repo', 'fast-lane', 'cross-check', 'no-delegation', 'plan-only'],
    lists: ['risk'],
  });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.reason) throw new UsageError('--reason is required');
  if (!args.values.by) throw new UsageError('--by is required');
  if (args.values.by !== 'user' && args.values.by !== 'auto') throw new UsageError('--by must be user or auto');
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const manifest = readManifest(paths, id);
  const requested = args.values.route;
  const route = requested === undefined ? manifest.route : ROUTES[requested];
  if (!route) throw new UsageError('--route must be direct, selected_advisors, full_pipeline, ag, or agentflow');
  const updates = {};
  let touched = false;
  for (const [flag, key] of [
    ['fast-lane', 'fast_lane'],
    ['cross-check', 'cross_check'],
    ['no-delegation', 'no_delegation'],
    ['plan-only', 'plan_only'],
  ]) {
    const value = boolOption(flag, args.values[flag]);
    if (value === undefined) continue;
    updates[key] = value;
    touched = true;
  }
  if (requested === undefined && !touched) throw new UsageError('--route or a modifier is required');
  const risks = args.lists.risk || [];
  for (const risk of risks) {
    if (!String(risk).trim()) throw new UsageError('--risk requires a value');
  }
  const previous = manifest.route;
  changeRoute(manifest, {
    route,
    reason: requested && requested !== route ? `${args.values.reason} via ${requested}` : args.values.reason,
    by: args.values.by,
    modifiers: touched ? updates : null,
    riskFeatures: risks,
  });
  if (manifest.route !== previous) manifest.implementation_authorized = false;
  recomputeAuthority(runDirectory(paths, id), manifest);
  writeManifest(paths, id, manifest);
  console.log(`route ${previous} ${route}`);
  console.log(`reason ${manifest.route_history[manifest.route_history.length - 1].reason}`);
  console.log(`by ${args.values.by}`);
  return 0;
}

function stop(argv) {
  const args = parseArgs(argv, { values: ['reason', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.reason || !args.values.reason.trim()) throw new UsageError('--reason is required');
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  const manifest = readManifest(paths, id);
  const status = setStatus(dir, manifest, 'stopped', args.values.reason.trim());
  console.log(`status ${status} ${id}`);
  return 0;
}

function done(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  const manifest = readManifest(paths, id);
  const result = markDone(repo.root, dir, manifest);
  writeReport(repo.root, dir, readManifest(paths, id));
  if (!result.ok) {
    for (const problem of result.problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log(`status done ${id}`);
  return 0;
}

module.exports = { start, baseline, resume, exportRun, setRoute, stop, done };
