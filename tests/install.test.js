'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT, toolFiles, toolHash } = require('../lib/tool');
const { copyFiles, walk, readJson } = require('../lib/fsutil');
const { planRepo } = require('../lib/commands/update');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-install-')));
}

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function sdd(bin, args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

function copyTool(dir) {
  copyFiles(TOOL_ROOT, toolFiles(TOOL_ROOT), dir);
  return path.join(dir, 'bin', 'sdd.js');
}

function gitStatus(repo) {
  return spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }).stdout;
}

function isIgnored(repo, rel) {
  return spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: repo }).status === 0;
}

module.exports = function installTests(test) {
  test('AC-P1-1 repo-local init with ignore keeps .sdd-dev out of git', () => {
    const repo = gitRepo(path.join(tmp(), 'app'));
    const result = sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
    assert.strictEqual(result.status, 0, output(result));
    assert(fs.existsSync(path.join(repo, '.sdd-dev', 'tool', 'bin', 'sdd.js')));
    assert(fs.existsSync(path.join(repo, '.sdd-dev', 'config', 'install.json')));
    assert(isIgnored(repo, '.sdd-dev/config/install.json'));
    assert.strictEqual(gitStatus(repo), '');
    const install = readJson(path.join(repo, '.sdd-dev', 'config', 'install.json'));
    assert.strictEqual(install.tool.path, '.sdd-dev/tool');
    assert(!JSON.stringify(install).includes(repo), 'install.json must not hold absolute paths');
  });

  test('AC-P1-2 switching to ignore reports tracked files and leaves them on disk', () => {
    const repo = gitRepo(path.join(tmp(), 'app'));
    assert.strictEqual(sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'track', '--yes']).status, 0);
    spawnSync('git', ['add', '.sdd-dev/config/install.json'], { cwd: repo });
    const switched = sdd(BIN, ['config', 'tracking', 'ignore', '--repo', repo]);
    assert.strictEqual(switched.status, 1, output(switched));
    assert.match(output(switched), /\.sdd-dev\/config\/install\.json: tracked by git/);
    const doctor = sdd(BIN, ['doctor', '--repo', repo]);
    assert.strictEqual(doctor.status, 1, output(doctor));
    assert.match(output(doctor), /\.sdd-dev\/config\/install\.json: tracked by git/);
    assert(fs.existsSync(path.join(repo, '.sdd-dev', 'config', 'install.json')));
    assert.match(gitStatus(repo), /\.sdd-dev\/config\/install\.json/);
  });

  test('AC-P1-3 a shared tool keeps each repo\'s runs in that repo', () => {
    const parent = tmp();
    const bin = copyTool(path.join(parent, 'sdd-dev'));
    const a = gitRepo(path.join(parent, 'a'));
    const b = gitRepo(path.join(parent, 'b'));
    for (const repo of [a, b]) {
      const result = sdd(bin, ['init', '--repo', repo, '--mode', 'shared-sibling', '--tracking', 'ignore']);
      assert.strictEqual(result.status, 0, output(result));
    }
    fs.mkdirSync(path.join(a, '.sdd-dev', 'runs', 'run-a'), { recursive: true });
    fs.writeFileSync(path.join(a, '.sdd-dev', 'runs', 'run-a', 'spec.md'), 'A only\n');
    const leaked = [...walk(path.join(b, '.sdd-dev')), ...walk(path.join(parent, 'sdd-dev'))]
      .filter((file) => file.includes('run-a') || file === 'spec.md' || file.endsWith('/spec.md'));
    assert.deepStrictEqual(leaked, []);
    assert(!fs.existsSync(path.join(b, '.sdd-dev', 'tool')));
    assert.deepStrictEqual(readJson(path.join(parent, 'sdd-dev', 'sdd-dev.local.json')).installs, [a, b].sort());
    for (const repo of [a, b]) assert.strictEqual(sdd(bin, ['doctor', '--repo', repo]).status, 0);
  });

  test('AC-P1-4 update without --apply leaves the tool untouched; --apply keeps runs', () => {
    const repo = gitRepo(path.join(tmp(), 'app'));
    assert.strictEqual(sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']).status, 0);
    const vendored = path.join(repo, '.sdd-dev', 'tool');
    const before = toolHash(vendored);
    const newer = path.join(tmp(), 'sdd-dev');
    const newerBin = copyTool(newer);
    fs.appendFileSync(path.join(newer, 'README.md'), '\nNewer release.\n');
    fs.mkdirSync(path.join(repo, '.sdd-dev', 'runs', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.sdd-dev', 'runs', 'r1', 'keep.md'), 'keep\n');

    const dry = sdd(newerBin, ['update', '--repo', repo]);
    assert.strictEqual(dry.status, 0, output(dry));
    assert.match(output(dry), /Dry run/);
    assert.strictEqual(toolHash(vendored), before);

    const applied = sdd(newerBin, ['update', '--repo', repo, '--apply']);
    assert.strictEqual(applied.status, 0, output(applied));
    assert.strictEqual(toolHash(vendored), toolHash(newer));
    assert(fs.existsSync(path.join(repo, '.sdd-dev', 'runs', 'r1', 'keep.md')));
    assert.strictEqual(sdd(BIN, ['doctor', '--repo', repo]).status, 0);
  });

  test('AC-P1-5 uninstall keeps config and runs; --purge needs --yes', () => {
    const repo = gitRepo(path.join(tmp(), 'app'));
    assert.strictEqual(sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']).status, 0);
    fs.mkdirSync(path.join(repo, '.sdd-dev', 'runs', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.sdd-dev', 'runs', 'r1', 'a.md'), 'a\n');

    const result = sdd(BIN, ['uninstall', '--repo', repo]);
    assert.strictEqual(result.status, 0, output(result));
    assert(!fs.existsSync(path.join(repo, '.sdd-dev', 'tool')));
    assert(fs.existsSync(path.join(repo, '.sdd-dev', 'config', 'install.json')));
    assert(fs.existsSync(path.join(repo, '.sdd-dev', 'runs', 'r1', 'a.md')));
    assert.match(result.stdout, /\.sdd-dev\/config\//);
    assert.match(result.stdout, /\.sdd-dev\/runs\//);
    assert.match(output(sdd(BIN, ['doctor', '--repo', repo])), /uninstalled/);

    assert.strictEqual(sdd(BIN, ['uninstall', '--repo', repo, '--purge']).status, 1);
    assert(fs.existsSync(path.join(repo, '.sdd-dev', 'runs', 'r1', 'a.md')));
    assert.strictEqual(sdd(BIN, ['uninstall', '--repo', repo, '--purge', '--yes']).status, 0);
    assert(!fs.existsSync(path.join(repo, '.sdd-dev')));
  });

  test('AC-P1-6 track lists what becomes tracked and still ignores local files', () => {
    const repo = gitRepo(path.join(tmp(), 'app'));
    const preview = sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'track']);
    assert.strictEqual(preview.status, 1, output(preview));
    assert.match(preview.stdout, /\.sdd-dev\/config\/install\.json/);
    assert.match(preview.stdout, /\.sdd-dev\/tool\/ \(\d+ tool files\)/);
    assert(!fs.existsSync(path.join(repo, '.sdd-dev')));

    const result = sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'track', '--yes']);
    assert.strictEqual(result.status, 0, output(result));
    assert(isIgnored(repo, '.sdd-dev/config/install.local.json'));
    assert(!isIgnored(repo, '.sdd-dev/config/install.json'));
  });

  test('AC-P1-7 doctor catches a moved shared-sibling repo; mode switch relinks it', () => {
    const parent = tmp();
    const bin = copyTool(path.join(parent, 'sdd-dev'));
    const original = gitRepo(path.join(parent, 'a'));
    assert.strictEqual(sdd(bin, ['init', '--repo', original, '--mode', 'shared-sibling', '--tracking', 'ignore']).status, 0);
    fs.mkdirSync(path.join(parent, 'nested'));
    const moved = path.join(parent, 'nested', 'a');
    fs.renameSync(original, moved);

    const doctor = sdd(bin, ['doctor', '--repo', moved]);
    assert.strictEqual(doctor.status, 1, output(doctor));
    assert.match(doctor.stdout, /does not resolve/);
    assert.match(doctor.stdout, /repo moved/);

    const relink = sdd(bin, ['mode', 'switch', 'shared-sibling', '--repo', moved]);
    assert.strictEqual(relink.status, 0, output(relink));
    assert.deepStrictEqual(readJson(path.join(parent, 'sdd-dev', 'sdd-dev.local.json')).installs, [moved]);
  });

  test('AC-P1-8 update lists pending migrations and a dry run keeps config bytes', () => {
    const migrations = [{ from: 1, to: 2, describe: 'rename a field', apply() {} }];
    const plan = planRepo({ config_schema: 1, tool: { hash: 'sha256:x' } }, 'sha256:x', 2, migrations);
    assert.strictEqual(plan.toolChanged, false);
    assert.deepStrictEqual(plan.migrations.map((step) => step.describe), ['rename a field']);
    assert.throws(() => planRepo({ config_schema: 3, tool: { hash: 'x' } }, 'x', 2, migrations), /downgrade/);
    assert.throws(() => planRepo({ config_schema: 1, tool: { hash: 'x' } }, 'x', 3, migrations), /no migration/);

    const repo = gitRepo(path.join(tmp(), 'app'));
    assert.strictEqual(sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']).status, 0);
    const installPath = path.join(repo, '.sdd-dev', 'config', 'install.json');
    const before = fs.readFileSync(installPath, 'utf8');
    const newer = path.join(tmp(), 'sdd-dev');
    const newerBin = copyTool(newer);
    fs.appendFileSync(path.join(newer, 'README.md'), '\nNewer release.\n');
    assert.strictEqual(sdd(newerBin, ['update', '--repo', repo]).status, 0);
    assert.strictEqual(fs.readFileSync(installPath, 'utf8'), before);
  });

  test('init in a git repo requires --tracking', () => {
    const repo = gitRepo(path.join(tmp(), 'app'));
    const result = sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local']);
    assert.strictEqual(result.status, 3);
    assert.match(result.stderr, /--tracking <track\|ignore> is required/);
    assert(!fs.existsSync(path.join(repo, '.sdd-dev')));
  });

  test('init outside git records snapshot storage without claiming isolation', () => {
    const dir = path.join(tmp(), 'plain');
    fs.mkdirSync(dir);
    const result = sdd(BIN, ['init', '--repo', dir, '--mode', 'repo-local']);
    assert.strictEqual(result.status, 0, output(result));
    assert.match(result.stdout, /no git isolation/);
    const install = readJson(path.join(dir, '.sdd-dev', 'config', 'install.json'));
    assert.strictEqual(install.vcs, 'snapshot');
    assert.strictEqual(install.tracking, null);
    assert.strictEqual(sdd(BIN, ['config', 'tracking', 'ignore', '--repo', dir]).status, 1);
    assert.strictEqual(sdd(BIN, ['doctor', '--repo', dir]).status, 0);
  });

  test('doctor flags secret-looking files in a vendored tool', () => {
    const repo = gitRepo(path.join(tmp(), 'app'));
    assert.strictEqual(sdd(BIN, ['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']).status, 0);
    fs.writeFileSync(path.join(repo, '.sdd-dev', 'tool', '.env'), 'TOKEN=x\n');
    const doctor = sdd(BIN, ['doctor', '--repo', repo]);
    assert.strictEqual(doctor.status, 1);
    assert.match(doctor.stdout, /secret-looking file in the tool: \.env/);
  });

  test('mode switch moves between shared-sibling and repo-local', () => {
    const parent = tmp();
    const bin = copyTool(path.join(parent, 'sdd-dev'));
    const repo = gitRepo(path.join(parent, 'a'));
    const registryFile = path.join(parent, 'sdd-dev', 'sdd-dev.local.json');
    assert.strictEqual(sdd(bin, ['init', '--repo', repo, '--mode', 'shared-sibling', '--tracking', 'ignore']).status, 0);

    const toLocal = sdd(bin, ['mode', 'switch', 'repo-local', '--repo', repo]);
    assert.strictEqual(toLocal.status, 0, output(toLocal));
    assert(fs.existsSync(path.join(repo, '.sdd-dev', 'tool', 'bin', 'sdd.js')));
    assert.deepStrictEqual(readJson(registryFile).installs, []);

    const toShared = sdd(bin, ['mode', 'switch', 'shared-sibling', '--repo', repo]);
    assert.strictEqual(toShared.status, 0, output(toShared));
    assert(!fs.existsSync(path.join(repo, '.sdd-dev', 'tool')));
    assert.deepStrictEqual(readJson(registryFile).installs, [repo]);
  });
};
