'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { checkRun } = require('../check');
const { openInstalled, listRunIds, resolveRunId, runDirectory } = require('../runstore');

module.exports = function check(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { paths } = openInstalled(args.values.repo);
  const ids = args.values.run ? [resolveRunId(paths, args.values.run)] : listRunIds(paths);
  const problems = [];
  for (const id of ids) problems.push(...checkRun(runDirectory(paths, id), id));
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log(ids.length ? `check ok (${ids.length})` : 'check ok');
  return 0;
};
