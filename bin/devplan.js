#!/usr/bin/env node
'use strict';

process.on('uncaughtException', (error) => {
  console.error(`devplan: ${error.message}`);
  process.exit(error.code && /^(INVALID|REPO_|ITEM_)/.test(error.code) ? 3 : 1);
});

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT, CONFIG_PATH, loadConfig, saveConfig, relativeRepoRoot, resolveRepoRoot } = require('../lib/config');
const { STATE_ROOT, validateRepoId, validateItem, projectContext, itemContext, repoIdForRoot } = require('../lib/resolver');
const { runScript } = require('../lib/run-check');
const { importState } = require('../lib/migration');
const { gateHook, pipelineHook } = require('../lib/hook');
const claudeSettings = require('../integrations/claude-code/settings');

const argv = process.argv.slice(2);
const command = argv.shift() || '';

function option(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}
function required(name) {
  const value = option(name);
  if (!value) {
    const error = new Error(`Missing --${name}`);
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  return value;
}
function finish(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
function checkerEnv(context) {
  return {
    DEVPLAN_GOTCHAS_PATH: path.join(context.projectStateRoot, 'refs', 'codebase-gotchas.md'),
    DEVPLAN_CODEBASE_PROFILE_PATH: path.join(context.projectStateRoot, 'refs', 'codebase-profile.json'),
  };
}
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function init() {
  fs.mkdirSync(path.join(STATE_ROOT, 'projects'), { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) saveConfig({ hookMode: 'warn', projects: {} });
  console.log(`Initialized ${TOOL_ROOT}`);
}

function register() {
  const repoPath = argv.find((value, index) => !value.startsWith('--') && argv[index - 1] !== '--id');
  const repoId = validateRepoId(required('id'));
  if (!repoPath) throw Object.assign(new Error('Missing repository path'), { code: 'INVALID_ARGUMENT' });
  const absolute = path.resolve(process.cwd(), repoPath);
  if (!fs.existsSync(path.join(absolute, '.git'))) throw Object.assign(new Error(`Not a Git repository: ${absolute}`), { code: 'INVALID_ARGUMENT' });
  const config = loadConfig();
  const real = fs.realpathSync(absolute);
  const duplicate = Object.entries(config.projects).find(([id, entry]) => id !== repoId && fs.existsSync(resolveRepoRoot(entry)) && fs.realpathSync(resolveRepoRoot(entry)) === real);
  if (duplicate) throw Object.assign(new Error(`Repository already registered as ${duplicate[0]}`), { code: 'DUPLICATE_REPO' });
  config.projects[repoId] = { repoRoot: relativeRepoRoot(absolute) };
  saveConfig(config);
  fs.mkdirSync(path.join(STATE_ROOT, 'projects', repoId, 'active'), { recursive: true });
  fs.mkdirSync(path.join(STATE_ROOT, 'projects', repoId, 'done'), { recursive: true });
  fs.mkdirSync(path.join(STATE_ROOT, 'projects', repoId, 'refs'), { recursive: true });
  console.log(`Registered ${repoId} -> ${config.projects[repoId].repoRoot}`);
}

function createItem() {
  const repoId = required('repo');
  const itemKey = validateItem(required('item'));
  const context = projectContext(repoId);
  const destination = path.join(context.projectStateRoot, 'active', ...itemKey.split('/'));
  if (fs.existsSync(destination)) throw Object.assign(new Error(`Item already exists: ${itemKey}`), { code: 'INVALID_ARGUMENT' });
  fs.cpSync(path.join(TOOL_ROOT, 'templates'), destination, { recursive: true });
  console.log(`Created ${repoId}/${itemKey}`);
}

function itemCommand(script, extra = []) {
  const context = itemContext(required('repo'), required('item'));
  finish(runScript(script, [context.itemDir, ...extra], { env: checkerEnv(context) }));
}

function hookCommand(kind) {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const repoRoot = path.resolve(required('repo-root'));
  repoIdForRoot(repoRoot);
  if (action === 'install') {
    const result = claudeSettings.install(repoRoot);
    console.log(`Installed Claude Code hooks in ${result.file}${result.backup ? ` (backup: ${result.backup})` : ''}`);
    return;
  }
  if (action === 'disable' || action === 'uninstall') {
    const result = claudeSettings.uninstall(repoRoot);
    console.log(`Removed devplan hooks from ${result.file}${result.backup ? ` (backup: ${result.backup})` : ''}`);
    return;
  }
  const result = kind === 'pipeline' ? pipelineHook(repoRoot, argv, readStdin()) : gateHook(repoRoot, argv, readStdin());
  if (result.output) console.error(result.output);
  process.exit(result.exitCode);
}

function doctor() {
  const config = loadConfig();
  const problems = [];
  const seen = new Map();
  console.log(`devplan doctor — ${TOOL_ROOT}`);
  for (const [repoId, entry] of Object.entries(config.projects)) {
    const repoRoot = resolveRepoRoot(entry);
    const resolved = fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : repoRoot;
    if (!fs.existsSync(path.join(repoRoot, '.git'))) problems.push(`${repoId}: repoRoot is not a Git repository (${repoRoot})`);
    if (seen.has(resolved)) problems.push(`${repoId}: duplicates ${seen.get(resolved)} (${resolved})`);
    seen.set(resolved, repoId);
    if (!fs.existsSync(path.join(STATE_ROOT, 'projects', repoId))) problems.push(`${repoId}: project state directory is missing`);
    console.log(`- ${repoId}: ${repoRoot}`);
  }
  if (Object.keys(config.projects).length < 2) problems.push('fewer than two repositories are registered');
  const ignoredState = spawnSync('git', ['check-ignore', '-q', 'state/test'], { cwd: TOOL_ROOT });
  const ignoredConfig = spawnSync('git', ['check-ignore', '-q', 'devplan.local.json'], { cwd: TOOL_ROOT });
  if (ignoredState.status !== 0 || ignoredConfig.status !== 0) problems.push('state or devplan.local.json is not ignored by Git');
  const tracked = spawnSync('git', ['ls-files'], { cwd: TOOL_ROOT, encoding: 'utf8' });
  const leaked = (tracked.stdout || '').split('\n').filter((file) =>
    /^(state\/|devplan\.local\.json$)|(?:^|\/)\.env(?:\.|$)|\.local\.json$|\.hook-log$|\.pipeline-hook-log$|\.html$/i.test(file)
  );
  if (leaked.length) problems.push(`private/generated files are tracked: ${leaked.join(', ')}`);
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  console.log('✓ configuration, isolation, and Git ignore checks passed');
}

switch (command) {
  case 'init': init(); break;
  case 'register': register(); break;
  case 'new': createItem(); break;
  case 'snapshot': itemCommand('snapshot.js'); break;
  case 'check': itemCommand('check.js', [required('gate')]); break;
  case 'fingerprint': itemCommand('gate-guard.js', ['--print-fingerprint']); break;
  case 'archive': itemCommand('check.js', ['archive']); break;
  case 'import-state': {
    const record = importState(required('repo'), required('from'));
    console.log(`Imported ${record.manifest.length} files for ${record.repoId}`);
    console.log(`Record: ${path.join(STATE_ROOT, 'migration-records')}`);
    break;
  }
  case 'hook': hookCommand('gate'); break;
  case 'pipeline-hook': hookCommand('pipeline'); break;
  case 'privacy-check': finish(runScript('privacy-check.js', [TOOL_ROOT])); break;
  case 'doctor': doctor(); break;
  default:
    console.error('Usage: devplan <init|register|new|snapshot|check|fingerprint|archive|import-state|hook|pipeline-hook|privacy-check|doctor>');
    process.exit(3);
}
