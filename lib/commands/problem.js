'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { now } = require('../fsutil');
const { splitIds } = require('../plan');
const { setStatus } = require('../manifest');
const { appendProblem, writeProblemUpdate, acceptEvidence } = require('../problems');
const { openInstalled, resolveRunId, readManifest, runDirectory } = require('../runstore');

function load(args) {
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  return { repo, paths, id, dir: runDirectory(paths, id), manifest: readManifest(paths, id) };
}

function parseAffects(raw, required) {
  const ids = splitIds(raw);
  if (!ids.length) {
    if (required) throw new UsageError('--affects is required');
    return [];
  }
  for (const id of ids) {
    if (!/^(?:R|AC|T)-[1-9][0-9]*$/.test(id)) throw new UsageError(`--affects has invalid id ${id}`);
  }
  return ids;
}

function add(argv) {
  const args = parseArgs(argv, {
    values: ['impact', 'handling', 'reason', 'affects', 'run', 'repo'],
    flags: ['blocks-downstream'],
  });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.impact || !args.values.impact.trim()) throw new UsageError('--impact is required');
  if (!args.values.handling || !args.values.handling.trim()) throw new UsageError('--handling is required');
  if (!args.values.reason || !args.values.reason.trim()) throw new UsageError('--reason is required');
  const downstream = args.flags['blocks-downstream'] === true;
  const affects = parseAffects(args.values.affects, downstream);
  const { id: runId, dir, manifest } = load(args);
  const problemId = appendProblem(dir, {
    impact: args.values.impact.trim(),
    handling: args.values.handling.trim(),
    reason: args.values.reason.trim(),
    result: '',
    blocks_downstream: downstream ? 'true' : 'false',
    affects: affects.join(', '),
    evidence: '',
  });
  if (downstream) {
    if (!Array.isArray(manifest.blocks)) manifest.blocks = [];
    const blockId = `problem:${problemId}`;
    if (!manifest.blocks.some((item) => item && item.id === blockId)) {
      manifest.blocks.push({
        id: blockId,
        affected: affects,
        condition: args.values.reason.trim(),
        at: now(),
      });
    }
  }
  const status = setStatus(dir, manifest, manifest.status, 'problem add');
  console.log(`problem ${problemId}`);
  console.log(`status ${status} ${runId}`);
  return 0;
}

function resolve(argv) {
  const args = parseArgs(argv, { values: ['result', 'evidence', 'run', 'repo'] });
  if (args._.length !== 1) throw new UsageError('usage: sdd problem resolve <P-n> --result <text> --evidence <path|sha>');
  const problemId = args._[0];
  if (!/^P-[1-9][0-9]*$/.test(problemId)) throw new UsageError('problem id must be P-<n>');
  if (!args.values.result || !args.values.result.trim()) throw new UsageError('--result is required');
  if (args.values.evidence === undefined) throw new UsageError('--evidence is required');
  const { repo, id: runId, dir, manifest } = load(args);
  const evidence = acceptEvidence(repo.root, dir, args.values.evidence);
  writeProblemUpdate(dir, problemId, {
    result: args.values.result.trim(),
    evidence,
  });
  const blockId = `problem:${problemId}`;
  const blocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
  const block = blocks.find((item) => item && item.id === blockId);
  if (block && !block.resolved_at) {
    block.evidence = evidence;
    block.resolved_at = now();
  }
  manifest.blocks = blocks;
  const status = setStatus(dir, manifest, manifest.status, 'problem resolve');
  console.log(`problem ${problemId}`);
  console.log(`status ${status} ${runId}`);
  return 0;
}

module.exports = { add, resolve };
