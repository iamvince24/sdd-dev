'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { install, uninstall } = require('../../integrations/claude-code/settings');
const { openInstalled } = require('../runstore');

function installCommand(argv) {
  const args = parseArgs(argv, { values: ['repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { repo } = openInstalled(args.values.repo);
  const result = install(repo.root);
  console.log(`hook install ${result.path}`);
  return 0;
}

function uninstallCommand(argv) {
  const args = parseArgs(argv, { values: ['repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { repo } = openInstalled(args.values.repo);
  uninstall(repo.root);
  console.log('hook uninstall');
  return 0;
}

module.exports = { install: installCommand, uninstall: uninstallCommand };
