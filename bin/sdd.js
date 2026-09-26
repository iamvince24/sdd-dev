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
  workspace add --id <id> --path <rel> --stack <text> [--repo <path>]
  workspace refresh --id <id> [--repo <path>]
  run start --workspace <id> (--source <path> | --source-stdin) --route <route> [--repo <path>]
  run baseline [--run <id>] [--repo <path>]
  run resume <run_id> [--repo <path>]
  run export <run_id> --out <path> [--repo <path>]
  run done [--run <id>] [--repo <path>]
  evidence write --ac <id> [--file <path>] [--run <id>] [--repo <path>]
  verify --ac <id> [--run <id>] [--repo <path>]
  grant add --op <op> --scope <scope> --source <Q-n> [--run <id>] [--repo <path>]
  grant check --op <op> --scope <scope> [--run <id>] [--repo <path>]
  spec write (--file <path> | stdin) [--run <id>] [--repo <path>]
  plan write (--file <path> | stdin) [--run <id>] [--repo <path>]
  plan approve [--auto-commit] [--carry-from <revision>] [--run <id>] [--repo <path>]
  plan revise [--run <id>] [--repo <path>]
  check [--stage spec|plan|dev] [--run <id>] [--repo <path>]
  commit --task <T-n> [--run <id>] [--repo <path>]
  context --role <role> [--task <T-n>] [--run <id>] [--repo <path>]
  hook install [--repo <path>]
  hook uninstall [--repo <path>]
  instructions render --route direct --platform <claude-code|cursor|codex>
  instructions install --route direct --platform <claude-code|cursor|codex> [--repo <path>]
  instructions uninstall --route direct --platform <claude-code|cursor|codex> [--repo <path>]

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

function workspaceCommand(argv) {
  const [sub, ...rest] = argv;
  const workspace = require('../lib/commands/workspace');
  if (sub === 'add') return workspace.add(rest);
  if (sub === 'refresh') return workspace.refresh(rest);
  throw new UsageError('usage: sdd workspace <add|refresh> ...');
}

function runCommand(argv) {
  const [sub, ...rest] = argv;
  const run = require('../lib/commands/run');
  if (sub === 'start') return run.start(rest);
  if (sub === 'baseline') return run.baseline(rest);
  if (sub === 'resume') return run.resume(rest);
  if (sub === 'export') return run.exportRun(rest);
  if (sub === 'done') return run.done(rest);
  throw new UsageError('usage: sdd run <start|baseline|resume|export|done> ...');
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

function specCommand(argv) {
  if (argv[0] !== 'write') throw new UsageError('usage: sdd spec write (--file <path> | stdin)');
  return require('../lib/commands/spec')(argv.slice(1));
}

function planCommand(argv) {
  const [sub, ...rest] = argv;
  const plan = require('../lib/commands/plan');
  if (sub === 'write') return plan.write(rest);
  if (sub === 'approve') return plan.approve(rest);
  if (sub === 'revise') return plan.revise(rest);
  throw new UsageError('usage: sdd plan <write|approve|revise> ...');
}

function hookCommand(argv) {
  const [sub, ...rest] = argv;
  const hook = require('../lib/commands/hook');
  if (sub === 'install') return hook.install(rest);
  if (sub === 'uninstall') return hook.uninstall(rest);
  throw new UsageError('usage: sdd hook <install|uninstall>');
}

function instructionsCommand(argv) {
  const [sub, ...rest] = argv;
  const instructions = require('../lib/commands/instructions');
  if (sub === 'render') return instructions.render(rest);
  if (sub === 'install') return instructions.install(rest);
  if (sub === 'uninstall') return instructions.uninstall(rest);
  throw new UsageError('usage: sdd instructions <render|install|uninstall> ...');
}

const COMMANDS = {
  'privacy-check': () => runScript('privacy-check.js', [TOOL_ROOT]),
  init: (argv) => require('../lib/commands/init')(argv),
  config: subcommand('config', 'tracking', (argv) => require('../lib/commands/tracking')(argv)),
  doctor: (argv) => require('../lib/commands/doctor')(argv),
  update: (argv) => require('../lib/commands/update')(argv),
  mode: subcommand('mode', 'switch', (argv) => require('../lib/commands/mode')(argv)),
  uninstall: (argv) => require('../lib/commands/uninstall')(argv),
  workspace: workspaceCommand,
  run: runCommand,
  evidence: evidenceCommand,
  verify: (argv) => require('../lib/commands/verify')(argv),
  grant: grantCommand,
  spec: specCommand,
  plan: planCommand,
  check: (argv) => require('../lib/commands/check')(argv),
  commit: (argv) => require('../lib/commands/commit')(argv),
  context: (argv) => require('../lib/commands/context')(argv),
  hook: hookCommand,
  instructions: instructionsCommand,
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
