'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson } = require('../lib/fsutil');
const { USER_ACTION_COMMANDS, classify } = require('../lib/guard');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');
const CAPABILITIES = path.join(TOOL_ROOT, 'integrations', 'capabilities.json');
const EXPECTED_CELLS = [
  'delegate',
  'readonly_review',
  'browser',
  'block_destructive_git',
  'block_git_commit',
  'grant_enforcement',
  'block_install_network',
  'verify_on_stop',
  'user_action',
];
const EXPECTED_USER_ACTIONS = [
  'spec approve',
  'plan approve',
  'approval revoke',
  'review carry',
  'run route --by user',
  'grant add',
  'review write --reviewer-kind human',
];

function sdd(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p12-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const initialized = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(initialized.status, 0, output(initialized));
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
  return repo;
}

function start(repo, platform, env = process.env) {
  const args = [
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md',
  ];
  if (platform) args.push('--platform', platform);
  const result = sdd(args, { env });
  assert.strictEqual(result.status, 0, output(result));
  const match = result.stdout.match(/^run (\S+)/m);
  assert(match, output(result));
  return readJson(path.join(repo, '.sdd-dev', 'runs', match[1], 'manifest.json'));
}

function withCapabilities(doc, fn) {
  const original = fs.readFileSync(CAPABILITIES);
  try {
    fs.writeFileSync(CAPABILITIES, `${JSON.stringify(doc, null, 2)}\n`);
    fn();
  } finally {
    fs.writeFileSync(CAPABILITIES, original);
  }
}

module.exports = function p12Tests(test) {
  test('AC-P12-1 an unspecified platform records all nine cells including unmeasured grant enforcement', () => {
    const repo = tmpRepo();
    const env = { ...process.env };
    delete env.SDD_PLATFORM;
    const manifest = start(repo, null, env);
    assert.strictEqual(manifest.platform, 'unknown');
    assert.deepStrictEqual(manifest.capability_limits.map((item) => item.op), EXPECTED_CELLS);
    const gap = manifest.capability_limits.find((item) => item.op === 'grant_enforcement');
    assert.deepStrictEqual({ layer: gap.layer, measured: gap.measured }, {
      layer: 'convention',
      measured: false,
    });
  });

  test('AC-P12-2 a measured false grant enforcement cell records a measured gap', () => {
    withCapabilities({ cells: { cursor: { grant_enforcement: false } } }, () => {
      const manifest = start(tmpRepo(), 'cursor');
      const gap = manifest.capability_limits.find((item) => item.op === 'grant_enforcement');
      assert.ok(gap);
      assert.strictEqual(gap.layer, 'convention');
      assert.strictEqual(gap.measured, true);
    });
  });

  test('AC-P12-3 a measured true grant enforcement cell creates no gap', () => {
    withCapabilities({ cells: { cursor: { grant_enforcement: true } } }, () => {
      const manifest = start(tmpRepo(), 'cursor');
      assert.strictEqual(manifest.capability_limits.some((item) => item.op === 'grant_enforcement'), false);
    });
  });

  test('AC-P12-4 required unmeasured grant enforcement blocks the run', () => {
    const repo = tmpRepo();
    const policyFile = path.join(repo, '.sdd-dev', 'config', 'policy.json');
    const policy = readJson(policyFile);
    policy.required_enforcement = ['grant_enforcement'];
    writeJson(policyFile, policy);
    const manifest = start(repo, 'cursor');
    const gap = manifest.capability_limits.find((item) => item.op === 'grant_enforcement');
    assert.ok(gap);
    assert.strictEqual(gap.measured, false);
    assert.strictEqual(manifest.status, 'blocked');
    assert.ok(manifest.blocks.some((item) => item.id === 'capability:grant_enforcement'));
  });

  test('P12-1 keeps the complete D-16 user action enumeration in code and platform docs', () => {
    assert.deepStrictEqual(USER_ACTION_COMMANDS, EXPECTED_USER_ACTIONS);
    for (const command of EXPECTED_USER_ACTIONS) {
      assert.deepStrictEqual(classify(`sdd ${command}`), { op: 'user_action', scope: command });
    }
    assert.strictEqual(classify('sdd run route --route direct --by auto'), null);

    const platforms = fs.readFileSync(path.join(TOOL_ROOT, 'docs', 'platforms.md'), 'utf8');
    for (const command of USER_ACTION_COMMANDS) {
      assert.ok(platforms.includes(`\`sdd ${command}\``), `docs/platforms.md is missing sdd ${command}`);
    }
  });
};
