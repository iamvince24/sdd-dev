'use strict';

const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { now } = require('../fsutil');
const { splitIds } = require('../plan');
const { setStatus } = require('../manifest');
const { acceptEvidence } = require('../problems');
const { openInstalled, resolveRunId, readManifest, runDirectory } = require('../runstore');

function load(args) {
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  return { repo, paths, id, dir: runDirectory(paths, id), manifest: readManifest(paths, id) };
}

function parseAffects(raw) {
  const ids = splitIds(raw);
  if (!ids.length) throw new UsageError('--affects is required');
  for (const id of ids) {
    if (!/^(?:R|AC|T)-[1-9][0-9]*$/.test(id)) throw new UsageError(`--affects has invalid id ${id}`);
  }
  return ids;
}

function refresh(dir, manifest, why) {
  if (!Array.isArray(manifest.blocks)) manifest.blocks = [];
  return setStatus(dir, manifest, manifest.status, why);
}

function add(argv) {
  const args = parseArgs(argv, { values: ['id', 'affects', 'condition', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!/^B-[1-9][0-9]*$/.test(args.values.id || '')) throw new UsageError('--id must be B-<n>');
  if (!args.values.condition || !args.values.condition.trim()) throw new UsageError('--condition is required');
  const affects = parseAffects(args.values.affects);
  const { id: runId, dir, manifest } = load(args);
  if (!Array.isArray(manifest.blocks)) manifest.blocks = [];
  const existing = manifest.blocks.some((item) => item && item.id === args.values.id);
  if (!existing) {
    manifest.blocks.push({
      id: args.values.id,
      affected: affects,
      condition: args.values.condition.trim(),
      at: now(),
    });
  }
  const status = refresh(dir, manifest, 'block add');
  console.log(`block ${args.values.id}`);
  console.log(`status ${status} ${runId}`);
  return 0;
}

function resolve(argv) {
  const args = parseArgs(argv, { values: ['evidence', 'run', 'repo'] });
  if (args._.length !== 1) throw new UsageError('usage: sdd block resolve <B-n> --evidence <path|sha>');
  const blockId = args._[0];
  if (!/^B-[1-9][0-9]*$/.test(blockId)) throw new UsageError('block id must be B-<n>');
  if (args.values.evidence === undefined) throw new UsageError('--evidence is required');
  const { repo, id: runId, dir, manifest } = load(args);
  const evidence = acceptEvidence(repo.root, dir, args.values.evidence);
  const blocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
  const block = blocks.find((item) => item && item.id === blockId);
  if (!block) throw new BlockedError(`manifest has no ${blockId}`);
  if (!block.resolved_at) {
    block.evidence = evidence;
    block.resolved_at = now();
  }
  manifest.blocks = blocks;
  const status = refresh(dir, manifest, 'block resolve');
  console.log(`block ${blockId}`);
  console.log(`status ${status} ${runId}`);
  return 0;
}

module.exports = { add, resolve };
