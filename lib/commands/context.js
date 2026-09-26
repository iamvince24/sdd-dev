'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { writeContext } = require('../context');
const { openInstalled, runDirectory, resolveRunId } = require('../runstore');

module.exports = function context(argv) {
  const args = parseArgs(argv, { values: ['role', 'task', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.role) throw new UsageError('--role is required');
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const written = writeContext(repo.root, runDirectory(paths, id), paths.config, args.values.role, args.values.task || null);
  console.log(`context ${written.context_id} ${id} ${written.rel}`);
  return 0;
};
