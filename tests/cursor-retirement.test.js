'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT, toolFiles } = require('../lib/tool');
const { copyFiles, readJson, writeJson } = require('../lib/fsutil');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cursor-retired-')));
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function cli(root, args, options = {}) {
  return spawnSync(process.execPath, [options.bin || BIN, ...args, '--repo', root], {
    encoding: 'utf8', env: { ...process.env, SDD_PLATFORM: '', ...options.env },
  });
}

function output(result) { return `${result.stdout}${result.stderr}`; }

function init(root, bin = BIN, mode = 'repo-local') {
  const result = cli(root, ['init', '--mode', mode, '--tracking', 'ignore'], { bin });
  assert.strictEqual(result.status, 0, output(result));
}

function source(root) {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'need.md'), 'Need a feature.\n');
}

function start(root, extra = [], options = {}) {
  return cli(root, ['run', 'start', '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md', ...extra], options);
}

function ownedFile(root, rel, contents) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

module.exports = function cursorRetirementTests(test) {
  test('retired Cursor platform is rejected before a new run changes workspace or run files', () => {
    const root = repo(); init(root); source(root);
    const workspaces = path.join(root, '.sdd-dev', 'config', 'workspaces.json');
    const runs = path.join(root, '.sdd-dev', 'runs');
    for (const [extra, env] of [
      [['--platform', 'cursor'], {}],
      [[], { SDD_PLATFORM: 'cursor' }],
      [['--platform', 'codex'], { SDD_PLATFORM: 'cursor' }],
    ]) {
      const result = start(root, extra, { env });
      assert.strictEqual(result.status, 3, output(result));
      assert.match(output(result), /platform|SDD_PLATFORM/);
      assert.strictEqual(fs.existsSync(workspaces), false);
      assert.deepStrictEqual(fs.readdirSync(runs), []);
    }
    const normal = start(root);
    assert.strictEqual(normal.status, 0, output(normal));
    const id = normal.stdout.match(/^run (\S+)/m)[1];
    assert.strictEqual(readJson(path.join(runs, id, 'manifest.json')).platform, 'unknown');
  });

  test('historical Cursor runs block next and mutations while export preserves run bytes', () => {
    const root = repo(); init(root); source(root);
    const started = start(root);
    assert.strictEqual(started.status, 0, output(started));
    const id = started.stdout.match(/^run (\S+)/m)[1];
    const dir = path.join(root, '.sdd-dev', 'runs', id);
    const manifestFile = path.join(dir, 'manifest.json');
    const manifest = readJson(manifestFile);
    manifest.platform = 'cursor';
    writeJson(manifestFile, manifest);
    const before = fs.readFileSync(manifestFile);
    for (const args of [
      ['run', 'next', '--run', id, '--json'],
      ['run', 'resume', id],
      ['run', 'baseline', '--run', id],
      ['run', 'route', '--route', 'direct', '--reason', 'test', '--by', 'user', '--run', id],
      ['metrics', '--run', id],
      ['check', '--stage', 'spec'],
    ]) {
      const result = cli(root, args);
      assert.strictEqual(result.status, 1, `${args.join(' ')}: ${output(result)}`);
      assert.match(output(result), /retired Cursor/);
      assert.deepStrictEqual(fs.readFileSync(manifestFile), before);
    }
    const out = path.join(root, 'old-run.tar');
    const exported = cli(root, ['run', 'export', id, '--out', out]);
    assert.strictEqual(exported.status, 0, output(exported));
    assert(fs.statSync(out).size > 0);
    assert.deepStrictEqual(fs.readFileSync(manifestFile), before);
  });

  test('old Cursor artifacts block reinit, update, mode, uninstall and purge without touching user content', () => {
    const root = repo(); init(root);
    const ownHooks = JSON.stringify({ hooks: { beforeShellExecution: [{ command: 'echo user' },
      { command: 'SDD_HOOK=1 node /old/integrations/cursor/hook.js shell' }] } }, null, 2);
    const hooks = ownedFile(root, '.cursor/hooks.json', ownHooks);
    const rule = ownedFile(root, '.cursor/rules/sdd-direct.mdc', 'user preface\n<!-- sdd-rule sha256:aaa -->\nold rule\n<!-- /sdd-rule -->\nuser suffix\n');
    const record = ownedFile(root, '.sdd-dev/instructions/cursor.json', '{"files":{}}\n');
    const backup = ownedFile(root, '.sdd-dev/hook/cursor-hooks.backup.json', '{"existed":true}\n');
    const install = path.join(root, '.sdd-dev/config/install.json');
    const files = [hooks, rule, record, backup, install];
    const before = files.map((file) => fs.readFileSync(file));
    for (const args of [
      ['init', '--mode', 'repo-local', '--tracking', 'ignore'],
      ['update', '--apply'],
      ['mode', 'switch', 'repo-local'],
      ['uninstall'],
      ['uninstall', '--purge', '--yes'],
    ]) {
      const result = cli(root, args);
      assert.strictEqual(result.status, 1, `${args.join(' ')}: ${output(result)}`);
      assert.match(output(result), /retired Cursor installation/);
      assert.match(output(result), /\.cursor\/hooks\.json/);
      assert.match(output(result), /\.cursor\/rules\/sdd-direct\.mdc/);
      files.forEach((file, i) => assert.deepStrictEqual(fs.readFileSync(file), before[i]));
    }
  });

  test('shared update checks all affected repos before changing either install', () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cursor-shared-')));
    const shared = path.join(parent, 'shared-tool');
    copyFiles(TOOL_ROOT, toolFiles(TOOL_ROOT), shared);
    const bin = path.join(shared, 'bin', 'sdd.js');
    const a = path.join(parent, 'a');
    const b = path.join(parent, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    spawnSync('git', ['init', '-q'], { cwd: a });
    spawnSync('git', ['init', '-q'], { cwd: b });
    init(a, bin, 'shared-sibling'); init(b, bin, 'shared-sibling');
    const installA = path.join(a, '.sdd-dev/config/install.json');
    const installB = path.join(b, '.sdd-dev/config/install.json');
    const beforeA = fs.readFileSync(installA);
    const beforeB = fs.readFileSync(installB);
    const bad = ownedFile(b, '.sdd-dev/instructions/cursor.json', '{}\n');
    fs.appendFileSync(path.join(shared, 'README.md'), '\nnew version\n');
    const result = cli(a, ['update', '--apply'], { bin });
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /retired Cursor installation/);
    assert.deepStrictEqual(fs.readFileSync(installA), beforeA);
    assert.deepStrictEqual(fs.readFileSync(installB), beforeB);
    assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{}\n');
  });

  test('user Cursor files are allowed, while damaged or linked legacy targets fail closed', () => {
    const root = repo();
    const hooks = ownedFile(root, '.cursor/hooks.json', '{"hooks":{"stop":[{"command":"echo user"}]}}\n');
    const rule = ownedFile(root, '.cursor/rules/sdd-direct.mdc', 'user-owned rule\n');
    init(root);
    assert.strictEqual(fs.readFileSync(hooks, 'utf8'), '{"hooks":{"stop":[{"command":"echo user"}]}}\n');
    assert.strictEqual(fs.readFileSync(rule, 'utf8'), 'user-owned rule\n');
    const outside = path.join(os.tmpdir(), `sdd-cursor-outside-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'keep\n');
    const record = path.join(root, '.sdd-dev/instructions/cursor.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.symlinkSync(outside, record);
    const rejected = cli(root, ['uninstall']);
    assert.strictEqual(rejected.status, 1, output(rejected));
    assert.match(output(rejected), /unsafe target/);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep\n');
    assert(fs.existsSync(path.join(root, '.sdd-dev/config/install.json')));
    fs.unlinkSync(record);
    fs.writeFileSync(hooks, '{broken json');
    const damaged = cli(root, ['mode', 'switch', 'repo-local']);
    assert.strictEqual(damaged.status, 1, output(damaged));
    assert.match(output(damaged), /cannot inspect \.cursor\/hooks\.json/);
    assert.strictEqual(fs.readFileSync(hooks, 'utf8'), '{broken json');
  });
};
