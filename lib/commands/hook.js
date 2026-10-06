'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { install: installClaude, uninstall: uninstallClaude } = require('../../integrations/claude-code/settings');
const { openInstalled } = require('../runstore');

function platformOf(args) {
  const platform = args.values.platform || 'claude-code';
  if (platform !== 'claude-code') {
    throw new UsageError('--platform must be claude-code');
  }
  return platform;
}

function installCommand(argv) {
  const args = parseArgs(argv, { values: ['repo', 'platform'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  platformOf(args);
  const { repo } = openInstalled(args.values.repo);
  const result = installClaude(repo.root);
  console.log(`hook install ${result.path}`);
  return 0;
}

function uninstallCommand(argv) {
  const args = parseArgs(argv, { values: ['repo', 'platform'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  platformOf(args);
  const { repo } = openInstalled(args.values.repo);
  uninstallClaude(repo.root);
  console.log('hook uninstall');
  return 0;
}

module.exports = { install: installCommand, uninstall: uninstallCommand };
