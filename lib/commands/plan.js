'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { writePlan, approvePlan, requestRevise } = require('../plan');
const { readPolicy } = require('../policy');
const { save, setStatus } = require('../manifest');
const { recomputeAuthority } = require('../route');
const { openInstalled, runDirectory, resolveRunId, readManifest } = require('../runstore');
const { appendEvent } = require('../events');

function readStdin() {
  if (process.stdin.isTTY) throw new UsageError('stdin is a terminal; pass --file or a pipe');
  return fs.readFileSync(0, 'utf8');
}

function write(argv) {
  const args = parseArgs(argv, { values: ['file', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  let text;
  if (args.values.file) {
    const abs = path.resolve(args.values.file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new BlockedError(`file not found: ${args.values.file}`);
    text = fs.readFileSync(abs, 'utf8');
  } else {
    text = readStdin();
  }
  const dir = runDirectory(paths, id);
  const written = writePlan(dir, text);
  const manifest = readManifest(paths, id);
  recomputeAuthority(dir, manifest);
  setStatus(dir, manifest, manifest.status, 'plan write');
  console.log(`plan r${written.revision} ${id}`);
  if (written.status) console.log(`status ${written.status} ${id}`);
  return 0;
}

function approve(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo', 'carry-from'], flags: ['auto-commit'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  let carryFrom = null;
  if (args.values['carry-from'] !== undefined) {
    carryFrom = Number(args.values['carry-from']);
    if (!Number.isInteger(carryFrom) || carryFrom < 1) throw new UsageError('--carry-from must be a revision number');
  }
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  appendEvent(dir, 'approval_request', { reason: 'plan' });
  const result = approvePlan(dir, {
    autoCommit: args.flags['auto-commit'] === true,
    repoRoot: repo.root,
    carryFrom,
  });
  appendEvent(dir, 'approval', { reason: 'plan' });
  const manifest = readManifest(paths, id);
  recomputeAuthority(dir, manifest);
  save(dir, manifest);
  console.log(`plan approval r${result.revision} ${id} auto_commit ${result.auto_commit}`);
  if (result.status) console.log(`status ${result.status} ${id}`);
  return 0;
}

function revise(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const policy = readPolicy(paths.config);
  const result = requestRevise(runDirectory(paths, id), policy.max_revise_rounds);
  console.log(`revise allowed ${id} rounds ${result.rounds}`);
  return 0;
}

module.exports = { write, approve, revise };
