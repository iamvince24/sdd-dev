'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { assertSafeId, openInstalled, runDirectory, resolveRunId, readManifest } = require('../runstore');
const { verifyAc } = require('../verify');

module.exports = function verify(argv) {
  const args = parseArgs(argv, { values: ['ac', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.ac) throw new UsageError('--ac is required');
  assertSafeId(args.values.ac, 'ac id');
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  return verifyAc({
    repoRoot: repo.root,
    runDir: runDirectory(paths, id),
    manifest: readManifest(paths, id),
    paths,
    ac: args.values.ac,
  });
};
