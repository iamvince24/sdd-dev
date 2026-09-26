'use strict';

const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { writeJson, now } = require('../fsutil');
const { writeMetrics, readMetrics, appendOutcome, metricsPath } = require('../metrics');
const { openInstalled, runDirectory, resolveRunId, readManifest } = require('../runstore');

function refresh(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  const doc = writeMetrics(dir, readManifest(paths, id));
  console.log(`metrics ${id}`);
  console.log(`waiting_ms ${doc.waiting_ms}`);
  console.log(`outcomes ${doc.outcomes === 'unknown' ? 'unknown' : doc.outcomes.length}`);
  return 0;
}

function outcome(argv) {
  const args = parseArgs(argv, { values: ['kind', 'basis', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.kind) throw new UsageError('--kind is required');
  if (!['rework', 'reopen', 'revert'].includes(args.values.kind)) {
    throw new UsageError('--kind must be rework, reopen, or revert');
  }
  if (!args.values.basis) throw new UsageError('--basis is required');
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  const manifest = readManifest(paths, id);
  if (manifest.status !== 'done') throw new BlockedError(`${id} is not done`);
  const existing = readMetrics(dir) || writeMetrics(dir, manifest);
  const first = existing.first_pass_success;
  const doc = appendOutcome(existing, { kind: args.values.kind, basis: args.values.basis, at: now() });
  if (JSON.stringify(doc.first_pass_success) !== JSON.stringify(first)) {
    throw new BlockedError('outcome changed first_pass_success');
  }
  writeJson(metricsPath(dir), doc);
  console.log(`outcome ${args.values.kind} ${id}`);
  console.log(`outcomes ${doc.outcomes.length}`);
  return 0;
}

module.exports = function metricsCommand(argv) {
  if (argv[0] === 'outcome') return outcome(argv.slice(1));
  if (argv[0] && !String(argv[0]).startsWith('--')) throw new UsageError(`unexpected argument: ${argv[0]}`);
  return refresh(argv);
};
