'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { readJson, writeJson, now } = require('../fsutil');
const { writeReport } = require('../verify');
const { openInstalled, runDirectory, resolveRunId, readManifest } = require('../runstore');

function revokeApproval(runDir, artifact, reason) {
  if (artifact !== 'spec' && artifact !== 'plan') throw new BlockedError('artifact must be spec or plan');
  const rel = `approvals/${artifact}.json`;
  const abs = path.join(runDir, rel);
  if (!fs.existsSync(abs)) throw new BlockedError(`missing ${rel}`);
  let doc;
  try {
    doc = readJson(abs);
  } catch (error) {
    throw new BlockedError(`cannot parse ${rel}: ${error.message}`);
  }
  if (!doc || typeof doc !== 'object' || !Number.isInteger(doc.revision)) {
    throw new BlockedError(`${rel} has no revision`);
  }
  const destRel = `approvals/revoked/${artifact}-r${doc.revision}.json`;
  const dest = path.join(runDir, destRel);
  if (fs.existsSync(dest)) throw new BlockedError(`${destRel} already exists`);
  doc.revoked_at = now();
  doc.reason = reason;
  writeJson(dest, doc);
  fs.unlinkSync(abs);
  return { revision: doc.revision, dest: destRel };
}

module.exports = function revoke(argv) {
  const args = parseArgs(argv, { values: ['artifact', 'reason', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const artifact = args.values.artifact;
  if (artifact !== 'spec' && artifact !== 'plan') throw new UsageError('--artifact must be spec or plan');
  if (!args.values.reason || !args.values.reason.trim()) throw new UsageError('--reason is required');
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  const result = revokeApproval(dir, artifact, args.values.reason.trim());
  writeReport(repo.root, dir, readManifest(paths, id));
  console.log(`revoked ${artifact} r${result.revision} ${id}`);
  return 0;
};
