'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { writeContext } = require('../context');
const { appendEvent } = require('../events');
const { openInstalled, runDirectory, resolveRunId } = require('../runstore');

const SUBAGENT_ROLES = new Set(['executor', 'plan-reviewer', 'security-reviewer', 'verifier']);

module.exports = function context(argv) {
  const args = parseArgs(argv, { values: ['role', 'task', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.role) throw new UsageError('--role is required');
  const { repo, paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  const written = writeContext(repo.root, dir, paths.config, args.values.role, args.values.task || null);
  if (SUBAGENT_ROLES.has(args.values.role)) {
    appendEvent(dir, 'subagent', { reason: written.context_id });
  }
  console.log(`context ${written.context_id} ${id} ${written.rel}`);
  return 0;
};
