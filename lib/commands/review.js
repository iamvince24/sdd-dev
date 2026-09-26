'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { currentPlanRevision } = require('../plan');
const { writeReview } = require('../review');
const { openInstalled, runDirectory, resolveRunId } = require('../runstore');

function readStdin() {
  if (process.stdin.isTTY) return '';
  return fs.readFileSync(0, 'utf8');
}

function revisionOf(value) {
  if (value === undefined) return null;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new UsageError('--revision must be a revision number');
  return revision;
}

module.exports = function reviewWrite(argv) {
  const args = parseArgs(argv, {
    values: ['kind', 'verdict', 'reviewer-kind', 'context-id', 'revision', 'file', 'run', 'repo'],
    flags: ['independent'],
  });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const kind = args.values.kind;
  if (kind !== 'plan' && kind !== 'result') throw new UsageError('--kind must be plan or result');
  const verdict = args.values.verdict;
  if (!verdict) throw new UsageError('--verdict is required');
  if (!['READY', 'REVISE', 'BLOCKED'].includes(verdict)) {
    throw new UsageError('--verdict must be READY, REVISE, or BLOCKED');
  }
  const reviewerKind = args.values['reviewer-kind'];
  if (!reviewerKind) throw new UsageError('--reviewer-kind is required');
  if (reviewerKind !== 'human' && reviewerKind !== 'agent') {
    throw new UsageError('--reviewer-kind must be human or agent');
  }
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  const requested = revisionOf(args.values.revision);
  const revision = requested == null ? currentPlanRevision(dir) : requested;
  if (!revision) throw new BlockedError('plan revision is missing');
  const frozen = path.join(dir, 'plan', 'revisions', `r${revision}.md`);
  if (!fs.existsSync(frozen)) throw new BlockedError(`plan revision r${revision} is missing`);
  let text = '';
  if (args.values.file) {
    const abs = path.resolve(args.values.file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new BlockedError(`file not found: ${args.values.file}`);
    text = fs.readFileSync(abs, 'utf8');
  } else {
    text = readStdin();
  }
  const written = writeReview(dir, {
    kind,
    revision,
    verdict,
    reviewerKind,
    independent: args.flags.independent === true,
    contextId: args.values['context-id'] || '',
    text,
  });
  console.log(`review ${written.rel} ${id}`);
  return 0;
};
