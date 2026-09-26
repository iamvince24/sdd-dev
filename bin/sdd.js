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
  run start --workspace <id> (--source <path> | --source-stdin) --route <route> [--repo <path>]
  run baseline [--run <id>] [--repo <path>]
  run resume <run_id> [--repo <path>]
  run export <run_id> --out <path> [--repo <path>]
  evidence write --ac <id> [--file <path>] [--run <id>] [--repo <path>]
  grant add --op <op> --scope <scope> --source <Q-n> [--run <id>] [--repo <path>]
  grant check --op <op> --scope <scope> [--run <id>] [--repo <path>]
  check [--run <id>] [--repo <path>]

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

function runCommand(argv) {
  const [sub, ...rest] = argv;
  const run = require('../lib/commands/run');
  if (sub === 'start') return run.start(rest);
  if (sub === 'baseline') return run.baseline(rest);
  if (sub === 'resume') return run.resume(rest);
  if (sub === 'export') return run.exportRun(rest);
  throw new UsageError('usage: sdd run <start|baseline|resume|export> ...');
}

function grantCommand(argv) {
  const [sub, ...rest] = argv;
  const grant = require('../lib/commands/grant');
  if (sub === 'add') return grant.add(rest);
  if (sub === 'check') return grant.check(rest);
  throw new UsageError('usage: sdd grant <add|check> ...');
}

function evidenceCommand(argv) {
  if (argv[0] !== 'write') throw new UsageError('usage: sdd evidence write --ac <id> [--file <path>]');
  return require('../lib/commands/evidence')(argv.slice(1));
}

const COMMANDS = {
  'privacy-check': () => runScript('privacy-check.js', [TOOL_ROOT]),
  init: (argv) => require('../lib/commands/init')(argv),
  config: subcommand('config', 'tracking', (argv) => require('../lib/commands/tracking')(argv)),
  doctor: (argv) => require('../lib/commands/doctor')(argv),
  update: (argv) => require('../lib/commands/update')(argv),
  mode: subcommand('mode', 'switch', (argv) => require('../lib/commands/mode')(argv)),
  uninstall: (argv) => require('../lib/commands/uninstall')(argv),
  run: runCommand,
  evidence: evidenceCommand,
  grant: grantCommand,
  check: (argv) => require('../lib/commands/check')(argv),
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
