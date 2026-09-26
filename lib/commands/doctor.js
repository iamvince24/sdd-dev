'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { resolveRepo } = require('../repo');
const { diagnose, printDiagnosis } = require('../doctor');

module.exports = function doctor(argv) {
  const args = parseArgs(argv, { values: ['repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const repo = resolveRepo(args.values.repo);
  console.log(`sdd doctor — ${repo.root}`);
  const result = diagnose(repo);
  printDiagnosis(result);
  return result.problems.length ? 1 : 0;
};
