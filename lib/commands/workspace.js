'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { openInstalled } = require('../runstore');
const { addWorkspace, refreshWorkspace } = require('../profile');

function printEntry(entry) {
  console.log(`workspace ${entry.id}`);
  console.log(`path ${entry.path}`);
  console.log(`stack ${entry.stack}`);
  for (const slot of entry.verify) {
    console.log(`${slot.id} ${slot.absent ? 'absent' : slot.command}`);
  }
}

function add(argv) {
  const args = parseArgs(argv, { values: ['id', 'path', 'stack', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.id) throw new UsageError('--id is required');
  if (!args.values.path) throw new UsageError('--path is required');
  if (args.values.stack == null) throw new UsageError('--stack is required');
  const { repo, paths } = openInstalled(args.values.repo);
  const entry = addWorkspace(paths, repo, {
    id: args.values.id,
    relPath: args.values.path,
    stack: args.values.stack,
  });
  printEntry(entry);
  return 0;
}

function refresh(argv) {
  const args = parseArgs(argv, { values: ['id', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.id) throw new UsageError('--id is required');
  const { repo, paths } = openInstalled(args.values.repo);
  printEntry(refreshWorkspace(paths, repo, args.values.id));
  return 0;
}

module.exports = { add, refresh };
