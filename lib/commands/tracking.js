'use strict';

const tracking = require('../tracking');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { resolveRepo, repoPaths } = require('../repo');
const { requireInstall, writeInstall } = require('../install');
const { now } = require('../fsutil');

module.exports = function configTracking(argv) {
  const args = parseArgs(argv, { values: ['repo'], flags: ['yes'] });
  const target = args._[0];
  if (args._.length !== 1 || !tracking.TRACKING.includes(target)) {
    throw new UsageError('usage: sdd config tracking <track|ignore> [--repo <path>] [--yes]');
  }
  const repo = resolveRepo(args.values.repo);
  const paths = repoPaths(repo.root);
  const { install } = requireInstall(paths);
  if (repo.vcs !== 'git') {
    throw new BlockedError('not a git repository: only the storage location is recorded; tracking does not apply');
  }
  if (target === 'track' && !args.flags.yes) {
    tracking.printTrackPreview(tracking.trackPreview(paths, ['.sdd-dev/.gitignore']));
    return 1;
  }

  tracking.writeRules(paths, target);
  install.tracking = target;
  install.updated_at = now();
  writeInstall(paths, install);

  const problems = tracking.check(paths, target);
  for (const problem of problems) console.log(`✗ ${problem}`);
  if (problems.length) return 1;
  console.log(target === 'track'
    ? 'Tracking: track. Run `git add .sdd-dev` when you want to commit it.'
    : '✓ Tracking: ignore. git does not see .sdd-dev/.');
  return 0;
};
