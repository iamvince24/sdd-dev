'use strict';

const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { openInstalled } = require('../runstore');
const instructions = require('../instructions');

function parsed(argv) {
  const args = parseArgs(argv, { values: ['route', 'platform', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (!args.values.route) throw new UsageError('--route is required');
  if (!args.values.platform) throw new UsageError('--platform is required');
  return args;
}

function render(argv) {
  const args = parsed(argv);
  const rendered = instructions.render(args.values.platform, args.values.route);
  process.stdout.write(rendered.text);
  return 0;
}

function install(argv) {
  const args = parsed(argv);
  const { repo } = openInstalled(args.values.repo);
  const rendered = instructions.installInto(repo.root, args.values.platform, args.values.route);
  console.log(`installed ${rendered.route} ${rendered.platform} ${rendered.dest}`);
  console.log(`verified ${rendered.verified}`);
  return 0;
}

function uninstall(argv) {
  const args = parsed(argv);
  if (!instructions.PLATFORMS.includes(args.values.platform)) {
    throw new UsageError(`--platform must be ${instructions.PLATFORMS.join(', ')}`);
  }
  instructions.loadRule(args.values.route);
  const { repo } = openInstalled(args.values.repo);
  const line = instructions.restoreOne(repo.root, args.values.platform, args.values.route);
  if (!line) {
    throw new BlockedError(`no ${args.values.route} instructions installed for ${args.values.platform}`);
  }
  console.log(line);
  return 0;
}

module.exports = { render, install, uninstall };
