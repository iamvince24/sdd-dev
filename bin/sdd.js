#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { UsageError, BlockedError } = require('../lib/errors');

const TOOL_ROOT = path.join(__dirname, '..');
const USAGE = `Usage: sdd <command> [options]

Commands:
  privacy-check
  init --mode <repo-local|shared-sibling> --tracking <track|ignore> [--repo <path>] [--yes]
  config tracking <track|ignore> [--repo <path>] [--yes]
  doctor [--repo <path>]
  update [--repo <path>] [--apply]
  mode switch <repo-local|shared-sibling> [--repo <path>] [--yes]
  uninstall [--repo <path>] [--purge [--yes]]

Exit codes: 0 ok, 1 blocked, 3 usage error.`;

function runScript(script, args) {
  const result = spawnSync(process.execPath, [path.join(TOOL_ROOT, 'scripts', script), ...args], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`sdd: ${result.error.message}`);
    return 3;
  }
  return result.status === null ? 1 : result.status;
}

function subcommand(name, sub, handler) {
  return (argv) => {
    if (argv[0] !== sub) throw new UsageError(`usage: sdd ${name} ${sub} ...`);
    return handler(argv.slice(1));
  };
}

const COMMANDS = {
  'privacy-check': () => runScript('privacy-check.js', [TOOL_ROOT]),
  init: (argv) => require('../lib/commands/init')(argv),
  config: subcommand('config', 'tracking', (argv) => require('../lib/commands/tracking')(argv)),
  doctor: (argv) => require('../lib/commands/doctor')(argv),
  update: (argv) => require('../lib/commands/update')(argv),
  mode: subcommand('mode', 'switch', (argv) => require('../lib/commands/mode')(argv)),
  uninstall: (argv) => require('../lib/commands/uninstall')(argv),
};

function main(argv) {
  const [command, ...rest] = argv;
  const handler = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : null;
  if (!handler) {
    console.error(USAGE);
    return 3;
  }
  try {
    return handler(rest);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`sdd: ${error.message}\n\n${USAGE}`);
      return 3;
    }
    if (error instanceof BlockedError) {
      console.error(`✗ ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
