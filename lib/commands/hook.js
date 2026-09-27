'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { install: installClaude, uninstall: uninstallClaude } = require('../../integrations/claude-code/settings');
const { install: installCursor, uninstall: uninstallCursor } = require('../../integrations/cursor/settings');
const { openInstalled } = require('../runstore');

function platformOf(args) {
  const platform = args.values.platform || 'claude-code';
  if (platform !== 'claude-code' && platform !== 'cursor') {
    throw new UsageError('--platform must be claude-code or cursor');
  }
  return platform;
}

function installCommand(argv) {
  const args = parseArgs(argv, { values: ['repo', 'platform'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { repo } = openInstalled(args.values.repo);
  const result = platformOf(args) === 'cursor' ? installCursor(repo.root) : installClaude(repo.root);
  console.log(`hook install ${result.path}`);
  return 0;
}

function uninstallCommand(argv) {
  const args = parseArgs(argv, { values: ['repo', 'platform'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { repo } = openInstalled(args.values.repo);
  if (platformOf(args) === 'cursor') uninstallCursor(repo.root);
  else uninstallClaude(repo.root);
  console.log('hook uninstall');
  return 0;
}

module.exports = { install: installCommand, uninstall: uninstallCommand };
