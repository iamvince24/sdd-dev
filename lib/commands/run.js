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
const { captureBaselineEvidence } = require('../verify');
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
    values: ['workspace', 'route', 'repo'],
    flags: ['source-stdin'],
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
  const manifest = buildManifest({ id, route, reason, repo, paths, workspace, sources });
  writeManifest(paths, id, manifest);
  const baseline = manifest.workspaces[0].baseline;
  console.log(`run ${id}`);
  console.log(`route ${route}`);
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
  recordDrift(paths, repo.root, id, readManifest(paths, id), 'resume', true);
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

module.exports = { start, baseline, resume, exportRun };
