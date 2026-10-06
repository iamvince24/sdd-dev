'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson } = require('../lib/fsutil');
const { revisionHash } = require('../lib/revision');
const { PLAN_KEYS } = require('../lib/plan');
const hook = require('../integrations/claude-code/hook');
const settings = require('../integrations/claude-code/settings');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');
const CAPABILITIES = path.join(TOOL_ROOT, 'integrations', 'capabilities.json');
const SPEC_KEYS = [
  'sources', 'clarifications', 'scope', 'exclusions', 'constraints', 'interfaces',
  'assumptions', 'deviations', 'requirements', 'acceptance',
];

function sdd(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p7-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function install(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

function start(repo, env = {}) {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
  const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
  assert.strictEqual(added.status, 0, output(added));
  const result = sdd([
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'full_pipeline', '--source', 'docs/need.md',
  ], { env: { ...process.env, ...env } });
  assert.strictEqual(result.status, 0, output(result));
  const match = result.stdout.match(/^run (\S+)/m);
  assert(match, output(result));
  return { id: match[1], run: path.join(repo, '.sdd-dev', 'runs', match[1]) };
}

function renderSpec() {
  const sections = {
    sources: 'docs/need.md\n',
    clarifications: '\n',
    scope: 'button\n',
    exclusions: '\n',
    constraints: '\n',
    interfaces: '\n',
    assumptions: '\n',
    deviations: '\n',
    requirements: '- id: R-1\n  text: show the button\n',
    acceptance: '- id: AC-1\n  requirement: R-1\n  kind: normal\n  given: a page\n  when: click\n  then: it opens\n  pass: visible\n',
  };
  const body = SPEC_KEYS.map((key) => `<!-- sec:${key} -->\n${sections[key].endsWith('\n') ? sections[key] : `${sections[key]}\n`}`).join('\n');
  return `---\nartifact: execution-spec\nrevision: 1\nstatus: draft\n---\n\n${body}`;
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

module.exports = function p7Tests(test) {
  test('AC-P7-1 an unsupported delegate cell rejects an independent agent review', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo);
    const specFile = path.join(repo, 'spec.md');
    fs.writeFileSync(specFile, renderSpec());
    assert.strictEqual(sdd(['spec', 'write', '--repo', repo, '--file', specFile]).status, 0);
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
    writeJson(path.join(run, 'approvals', 'spec.json'), {
      artifact: 'execution-spec',
      revision: 1,
      content_hash: hash,
      approved_at: '2026-09-26T00:00:00.000Z',
      carried_from: null,
    });
    const sections = {
      goals: 'ship\n',
      scope: 'button\n',
      constraints: '\n',
      decisions: '\n',
      interfaces: '\n',
      paths: 'src/a.ts\n',
      dependencies: '\n',
      tasks: '- id: T-1\n  purpose: button\n  paths: src/a.ts\n  integrator: planner\n  depends:\n  acceptance: AC-1\n  commit: button\n  preexisting_overlap:\n  reason:\n  status: pending\n',
      verification: '- id: AC-1\n  method: manual\n',
      notes: '\n',
    };
    const body = PLAN_KEYS.map((key) => `<!-- sec:${key} -->\n${sections[key]}`).join('\n');
    const plan = `---\nartifact: plan\nrevision: 1\nstatus: draft\nbased_on:\n  artifact: execution-spec\n  revision: 1\n  content_hash: ${hash}\n---\n\n${body}`;
    const planFile = path.join(repo, 'plan.md');
    fs.writeFileSync(planFile, plan);
    assert.strictEqual(sdd(['plan', 'write', '--repo', repo, '--file', planFile]).status, 0);
    const review = path.join(run, 'review', 'plan-review-r1.md');
    fs.mkdirSync(path.dirname(review), { recursive: true });
    fs.writeFileSync(review, '---\nartifact: plan-review\nrevision: 1\nverdict: READY\nreviewer_kind: agent\nindependent: true\ncontext_id: reviewer-1\n---\n\n- id: D1\n  status: checked\n- id: D2\n  status: checked\n- id: D3\n  status: checked\n- id: D4\n  status: checked\n- id: D5\n  status: checked\n- id: D6\n  status: checked\n- id: D7\n  status: checked\n');
    const manifestFile = path.join(run, 'manifest.json');
    const manifest = readJson(manifestFile);
    manifest.platform = 'claude-code';
    writeJson(manifestFile, manifest);

    withCapabilities({ cells: { 'claude-code': { delegate: false }, codex: { delegate: true } } }, () => {
      const blocked = sdd(['check', '--stage', 'plan', '--repo', repo]);
      assert.strictEqual(blocked.status, 1, output(blocked));
      assert.match(output(blocked), /platform matrix claude-code delegate is not supported/);
    });
    withCapabilities({ cells: { codex: { delegate: true } } }, () => {
      const open = sdd(['check', '--stage', 'plan', '--repo', repo]);
      assert.strictEqual(open.status, 0, output(open));
      assert.doesNotMatch(output(open), /delegate is not supported/);
    });
  });

  test('AC-P7-4 an unsupported destructive-git cell is a convention gap and can block the run', () => {
    const matrix = { cells: { 'claude-code': { block_destructive_git: false }, codex: { delegate: true } } };
    withCapabilities(matrix, () => {
      const open = tmpRepo();
      install(open);
      const started = start(open, { SDD_PLATFORM: 'claude-code' });
      const manifest = readJson(path.join(started.run, 'manifest.json'));
      const gap = manifest.capability_limits.find((item) => item.op === 'block_destructive_git');
      assert.ok(gap);
      assert.strictEqual(gap.layer, 'convention');
      assert.strictEqual(gap.measured, true);
      assert.strictEqual(manifest.status, 'active');
      const delegate = manifest.capability_limits.find((item) => item.op === 'delegate');
      assert.ok(delegate);
      assert.strictEqual(delegate.layer, 'convention');
      assert.strictEqual(delegate.measured, false);

      const held = tmpRepo();
      install(held);
      const policy = readJson(path.join(held, '.sdd-dev', 'config', 'policy.json'));
      policy.required_enforcement = ['block_destructive_git'];
      writeJson(path.join(held, '.sdd-dev', 'config', 'policy.json'), policy);
      const blocked = start(held, { SDD_PLATFORM: 'claude-code' });
      const blockedManifest = readJson(path.join(blocked.run, 'manifest.json'));
      assert.strictEqual(blockedManifest.status, 'blocked');
      assert.ok(blockedManifest.blocks.some((item) => item.id === 'capability:block_destructive_git'));
      assert.strictEqual(blockedManifest.capability_limits.find((item) => item.op === 'block_destructive_git').layer, 'convention');
    });
  });

  test('unmeasured cells stay measured false and are not copied as true across platforms', () => {
    const { CELLS } = require('../lib/capabilities');
    const cellOps = CELLS.map((item) => item[0]);

    const claudeRepo = tmpRepo();
    install(claudeRepo);
    const claudeRun = start(claudeRepo, { SDD_PLATFORM: 'claude-code' });
    const claudeManifest = readJson(path.join(claudeRun.run, 'manifest.json'));
    const claudeByOp = new Map(claudeManifest.capability_limits.map((item) => [item.op, item]));
    assert.deepStrictEqual([...claudeByOp.keys()].sort(), cellOps.slice().sort());
    assert.strictEqual(claudeByOp.get('delegate').measured, false);
    assert.strictEqual(claudeByOp.get('browser').measured, false);

    const codexRepo = tmpRepo();
    install(codexRepo);
    const codexRun = start(codexRepo, { SDD_PLATFORM: 'codex' });
    const codexManifest = readJson(path.join(codexRun.run, 'manifest.json'));
    const codexByOp = new Map(codexManifest.capability_limits.map((item) => [item.op, item]));
    assert.strictEqual(codexByOp.has('block_git_commit'), false);
    assert.strictEqual(codexByOp.get('block_destructive_git').measured, true);
    assert.strictEqual(codexByOp.get('block_install_network').measured, true);
    assert.strictEqual(codexByOp.get('browser').measured, false);
    assert.ok(codexManifest.capability_limits.every((item) => item.layer === 'convention'));
    assert.strictEqual(codexManifest.status, 'active');

    const held = tmpRepo();
    install(held);
    const policy = readJson(path.join(held, '.sdd-dev', 'config', 'policy.json'));
    policy.required_enforcement = ['block_install_network'];
    writeJson(path.join(held, '.sdd-dev', 'config', 'policy.json'), policy);
    const blocked = start(held, { SDD_PLATFORM: 'codex' });
    const blockedManifest = readJson(path.join(blocked.run, 'manifest.json'));
    assert.strictEqual(blockedManifest.status, 'blocked');
    assert.ok(blockedManifest.blocks.some((item) => item.id === 'capability:block_install_network'));
  });

  test('AC-P7-2 uninstall removes only the sdd hook entry', () => {
    const repo = tmpRepo();
    install(repo);
    const file = path.join(repo, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep-me' }] }] },
    };
    writeJson(file, original);
    const before = fs.readFileSync(file);
    assert.strictEqual(sdd(['hook', 'install', '--repo', repo]).status, 0);
    const backup = readJson(`${settings.backupPath(repo)}.json`);
    assert.strictEqual(backup.existed, true);
    assert.deepStrictEqual(Buffer.from(backup.original_base64, 'base64'), before);
    const installed = readJson(file);
    assert.ok(installed.hooks.PreToolUse.some((group) => group.hooks.some(settings.isSddHook)));
    assert.ok(installed.hooks.PreToolUse.some((group) => group.hooks.some((item) => item.command === 'echo keep-me')));
    assert.strictEqual(sdd(['hook', 'uninstall', '--repo', repo]).status, 0);
    const after = readJson(file);
    assert.ok(after.hooks.PreToolUse.some((group) => group.hooks.some((item) => item.command === 'echo keep-me')));
    assert.strictEqual(after.hooks.PreToolUse.some((group) => group.hooks.some(settings.isSddHook)), false);
  });

  test('AC-P7-3 a Q-n grant cannot authorize force_push without a verified user source', () => {
    const repo = tmpRepo();
    install(repo);
    const { id } = start(repo);
    const added = sdd(['grant', 'add', '--repo', repo, '--op', 'force_push', '--scope', 'feature/x', '--source', 'Q-1']);
    assert.strictEqual(added.status, 0, output(added));
    assert.deepStrictEqual(hook.destructiveOp('git push --force origin feature/x'), { op: 'force_push', scope: 'feature/x' });
    assert.deepStrictEqual(hook.destructiveOp('git push -f origin main'), { op: 'force_push', scope: 'main' });
    const allowed = hook.evaluate(repo, 'git push --force origin feature/x');
    assert.strictEqual(allowed.allow, false);
    assert.match(allowed.reason, /source unconfirmed/);
    const checked = sdd(['grant', 'check', '--repo', repo, '--op', 'force_push', '--scope', 'feature/x']);
    assert.strictEqual(checked.status, 1);
    const denied = hook.evaluate(repo, 'git push --force origin main');
    assert.strictEqual(denied.allow, false);
    assert.match(denied.reason, /no grant: force_push main/);
    const payload = JSON.stringify({ tool_input: { command: 'git push --force origin main' } });
    const ran = spawnSync(process.execPath, [path.join(TOOL_ROOT, 'integrations', 'claude-code', 'hook.js')], {
      cwd: repo,
      input: payload,
      encoding: 'utf8',
    });
    assert.strictEqual(ran.status, 2, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stderr, /force_push main/);
    const granted = spawnSync(process.execPath, [path.join(TOOL_ROOT, 'integrations', 'claude-code', 'hook.js')], {
      cwd: repo,
      input: JSON.stringify({ tool_input: { command: 'git push --force origin feature/x' } }),
      encoding: 'utf8',
    });
    assert.strictEqual(granted.status, 2, `${granted.stdout}${granted.stderr}`);
    assert.strictEqual(id.length > 0, true);
  });
};
