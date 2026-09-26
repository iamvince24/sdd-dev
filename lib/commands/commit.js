'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { commitTask } = require('../commit');
const { openInstalled, runDirectory, resolveRunId } = require('../runstore');

module.exports = function commit(argv) {
  const args = parseArgs(argv, { values: ['task', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.task) throw new UsageError('--task is required');
  if (!/^T-[1-9][0-9]*$/.test(args.values.task)) throw new UsageError('--task must be T-n');
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const result = commitTask(repo.root, runDirectory(paths, id), id, args.values.task);
  if (!result.ok) {
    for (const problem of result.problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log(`commit ${args.values.task} ${result.head}`);
  return 0;
};
