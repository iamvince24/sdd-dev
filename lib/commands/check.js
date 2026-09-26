'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { checkRun } = require('../check');
const { checkSpec } = require('../spec');
const { openInstalled, listRunIds, resolveRunId, runDirectory } = require('../runstore');

module.exports = function check(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo', 'stage'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (args.values.stage && args.values.stage !== 'spec') throw new UsageError('--stage must be spec');
  const { paths } = openInstalled(args.values.repo);
  const ids = args.values.run ? [resolveRunId(paths, args.values.run)] : listRunIds(paths);
  const problems = [];
  for (const id of ids) {
    const dir = runDirectory(paths, id);
    if (args.values.stage === 'spec') {
      const spec = checkSpec(dir, id);
      for (const note of spec.notes) console.log(`note ${note}`);
      problems.push(...spec.problems);
    }
    problems.push(...checkRun(dir, id));
  }
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log(ids.length ? `check ok (${ids.length})` : 'check ok');
  return 0;
};
