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
  run start --workspace <id> (--source <path> | --source-stdin) --route <route> [--platform <claude-code|cursor|codex>] [--fast-lane] [--cross-check] [--no-delegation] [--plan-only] [--stop-after spec|plan|T-n] [--repo <path>]
  run next [--run <id>] [--json] [--repo <path>]
  run baseline [--run <id>] [--repo <path>]
  run resume <run_id> [--repo <path>]
  run export <run_id> --out <path> [--repo <path>]
  run done [--run <id>] [--repo <path>]
  run stop --reason <text> [--run <id>] [--repo <path>]
  run route [--route <route>] --reason <text> --by <user|auto> [--risk <feature>] [--fast-lane true|false] [--cross-check true|false] [--no-delegation true|false] [--plan-only true|false] [--run <id>] [--repo <path>]
  route suggest --risk <feature> [--run <id>] [--repo <path>]
  block add --id <B-n> --affects <R-n,AC-n,T-n> --condition <text> [--run <id>] [--repo <path>]
  block resolve <B-n> --evidence <path|sha> [--run <id>] [--repo <path>]
  problem add --impact <text> --handling <text> --reason <text> [--blocks-downstream] [--affects <R-n,AC-n,T-n>] [--run <id>] [--repo <path>]
  problem resolve <P-n> --result <text> --evidence <path|sha> [--run <id>] [--repo <path>]
  metrics [--run <id>] [--repo <path>]
  metrics outcome --kind <rework|reopen|revert> --basis <text> [--run <id>] [--repo <path>]
  evidence write --ac <id> [--file <path>] [--run <id>] [--repo <path>]
  verify --ac <id> [--run <id>] [--repo <path>]
  grant add --op <op> --scope <scope> --source <Q-n> [--run <id>] [--repo <path>]
  grant check --op <op> --scope <scope> [--run <id>] [--repo <path>]
  spec write (--file <path> | stdin) [--run <id>] [--repo <path>]
  spec approve [--carry-from <revision>] [--changed <requirement,design,risk>] [--run <id>] [--repo <path>]
  plan write (--file <path> | stdin) [--run <id>] [--repo <path>]
  plan approve [--auto-commit] [--carry-from <revision>] [--run <id>] [--repo <path>]
  plan revise [--run <id>] [--repo <path>]
  approval revoke --artifact <spec|plan> --reason <text> [--run <id>] [--repo <path>]
  check [--stage spec|plan|dev] [--run <id>] [--repo <path>]
  review write --kind <plan|result> --verdict <READY|REVISE|BLOCKED> --reviewer-kind <human|agent> [--independent] [--context-id <id>] [--revision <n>] [--file <findings>] [--run <id>] [--repo <path>]
  review prepare --file <review-input.json> [--run <id>] [--repo <path>]
  review carry --kind <plan|result> --from <revision> [--run <id>] [--repo <path>]
  commit --task <T-n> [--run <id>] [--repo <path>]
  context --role <role> [--task <T-n>] [--run <id>] [--repo <path>]
  hook install [--platform <claude-code|cursor>] [--repo <path>]
  hook uninstall [--platform <claude-code|cursor>] [--repo <path>]
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
  if (sub === 'next') return run.next(rest);
  if (sub === 'baseline') return run.baseline(rest);
  if (sub === 'resume') return run.resume(rest);
  if (sub === 'export') return run.exportRun(rest);
  if (sub === 'done') return run.done(rest);
  if (sub === 'stop') return run.stop(rest);
  if (sub === 'route') return run.setRoute(rest);
  throw new UsageError('usage: sdd run <start|next|baseline|resume|export|done|stop|route> ...');
}

function blockCommand(argv) {
  const [sub, ...rest] = argv;
  const block = require('../lib/commands/block');
  if (sub === 'add') return block.add(rest);
  if (sub === 'resolve') return block.resolve(rest);
  throw new UsageError('usage: sdd block <add|resolve> ...');
}

function problemCommand(argv) {
  const [sub, ...rest] = argv;
  const problem = require('../lib/commands/problem');
  if (sub === 'add') return problem.add(rest);
  if (sub === 'resolve') return problem.resolve(rest);
  throw new UsageError('usage: sdd problem <add|resolve> ...');
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
  const [sub, ...rest] = argv;
  const spec = require('../lib/commands/spec');
  if (sub === 'write') return spec.write(rest);
  if (sub === 'approve') return spec.approve(rest);
  throw new UsageError('usage: sdd spec <write|approve> ...');
}

function approvalCommand(argv) {
  if (argv[0] !== 'revoke') throw new UsageError('usage: sdd approval revoke --artifact <spec|plan> --reason <text>');
  return require('../lib/commands/approval')(argv.slice(1));
}

function reviewCommand(argv) {
  const [sub, ...rest] = argv;
  const review = require('../lib/commands/review');
  if (sub === 'prepare') return review.prepare(rest);
  if (sub === 'write') return review.write(rest);
  if (sub === 'carry') return review.carry(rest);
  throw new UsageError('usage: sdd review <prepare|write|carry> ...');
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
  route: (argv) => {
    if (argv[0] !== 'suggest') throw new UsageError('usage: sdd route suggest --risk <feature>');
    return require('../lib/commands/route').suggest(argv.slice(1));
  },
  block: blockCommand,
  problem: problemCommand,
  evidence: evidenceCommand,
  verify: (argv) => require('../lib/commands/verify')(argv),
  grant: grantCommand,
  spec: specCommand,
  plan: planCommand,
  approval: approvalCommand,
  review: reviewCommand,
  check: (argv) => require('../lib/commands/check')(argv),
  metrics: (argv) => require('../lib/commands/metrics')(argv),
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
