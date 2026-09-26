'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { checkRun } = require('../check');
const { preexistingProblems } = require('../verify');
const { checkSpec } = require('../spec');
const { checkPlan, applyPlanOnlyStop } = require('../plan');
const { checkDev } = require('../scope');
const { readPolicy } = require('../policy');
const { openInstalled, listRunIds, resolveRunId, runDirectory } = require('../runstore');

module.exports = function check(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo', 'stage'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (args.values.stage && args.values.stage !== 'spec' && args.values.stage !== 'plan' && args.values.stage !== 'dev') {
    throw new UsageError('--stage must be spec, plan, or dev');
  }
  const { repo, paths } = openInstalled(args.values.repo);
  if (args.values.stage === 'plan') readPolicy(paths.config);
  const ids = args.values.run ? [resolveRunId(paths, args.values.run)] : listRunIds(paths);
  const problems = [];
  for (const id of ids) {
    const dir = runDirectory(paths, id);
    let stageProblems = [];
    if (args.values.stage === 'spec') {
      const spec = checkSpec(dir, id);
      for (const note of spec.notes) console.log(`note ${note}`);
      stageProblems = spec.problems;
    } else if (args.values.stage === 'plan') {
      const plan = checkPlan(dir, id);
      for (const note of plan.notes) console.log(`note ${note}`);
      stageProblems = plan.problems;
    } else if (args.values.stage === 'dev') {
      const dev = checkDev(repo.root, dir, id, paths);
      if (dev.reassess.length) console.log(`route_reassess ${dev.reassess.join(' ')}`);
      stageProblems = dev.problems;
    }
    const hashProblems = checkRun(dir, id);
    const priorProblems = preexistingProblems(dir, id);
    if (args.values.stage === 'plan' && !stageProblems.length && !hashProblems.length && !priorProblems.length) {
      const status = applyPlanOnlyStop(dir, 'reviewed');
      if (status) console.log(`status ${status} ${id}`);
    }
    problems.push(...stageProblems, ...hashProblems, ...priorProblems);
  }
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log(ids.length ? `check ok (${ids.length})` : 'check ok');
  return 0;
};
