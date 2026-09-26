'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { computeCodebase } = require('../codebase');
const { writeJson, now } = require('../fsutil');
const { redactBytes } = require('../redact');
const { recordRedaction } = require('../problems');
const { assertSafeId, openInstalled, runDirectory, resolveRunId, readManifest } = require('../runstore');

function readStdin() {
  if (process.stdin.isTTY) throw new UsageError('stdin is a terminal; pass --file or a pipe');
  return fs.readFileSync(0);
}

module.exports = function evidenceWrite(argv) {
  const args = parseArgs(argv, { values: ['ac', 'file', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.ac) throw new UsageError('--ac is required');
  assertSafeId(args.values.ac, 'ac id');
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const manifest = readManifest(paths, id);
  const workspace = manifest.workspaces && manifest.workspaces[0];
  if (!workspace) throw new BlockedError('run has no workspace');

  let bytes;
  if (args.values.file) {
    const abs = path.resolve(args.values.file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new BlockedError(`file not found: ${args.values.file}`);
    bytes = fs.readFileSync(abs);
  } else {
    bytes = readStdin();
  }

  const current = computeCodebase(repo.root, workspace.path || '.');
  const redacted = redactBytes(bytes);
  const dir = path.join(runDirectory(paths, id), 'evidence', args.values.ac);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.txt'), redacted.bytes);
  writeJson(path.join(dir, 'meta.json'), {
    ac: args.values.ac,
    workspace: workspace.id,
    codebase_ref: current.codebase_ref,
    written_at: now(),
    stale: false,
    stale_reason: null,
    redacted: redacted.changed,
  });
  if (redacted.changed) recordRedaction(runDirectory(paths, id), `evidence/${args.values.ac}/output.txt`);
  console.log(`evidence ${args.values.ac} ${id}`);
  return 0;
};
