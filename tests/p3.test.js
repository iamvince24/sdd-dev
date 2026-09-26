'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, walk } = require('../lib/fsutil');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');

function sdd(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p3-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function commit(repo, files, message) {
  const added = spawnSync('git', ['add', '--', ...files], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(added.status, 0, added.stderr);
  const committed = spawnSync('git', [
    '-c', `user.email=${['dev@', 'example.com'].join('')}`,
    '-c', 'user.name=dev',
    'commit', '-q', '-m', message,
  ], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(committed.status, 0, `${committed.stdout}${committed.stderr}`);
}

function head(repo) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
}

function install(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

function writeNeed(repo, body = 'need\n') {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), body);
}

function start(repo, extra = []) {
  const result = sdd([
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md',
    ...extra,
  ]);
  assert.strictEqual(result.status, 0, output(result));
  const match = result.stdout.match(/^run (\S+)/m);
  assert(match, output(result));
  return { id: match[1], output: output(result) };
}

function workspaces(repo) {
  return readJson(path.join(repo, '.sdd-dev', 'config', 'workspaces.json'));
}

function slot(repo, id) {
  return workspaces(repo).workspaces[0].verify.find((item) => item.id === id);
}

function manifest(repo, id) {
  return readJson(path.join(repo, '.sdd-dev', 'runs', id, 'manifest.json'));
}

module.exports = function p3Tests(test) {
  test('AC-P3-1 workspace add records npm test and only relative paths', () => {
    const repo = tmpRepo();
    install(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
      name: 'do-not-guess',
      version: '1.2.3',
      scripts: { test: 'node test.js' },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# local rules\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Do Not Guess Stack\n');
    const result = sdd([
      'workspace', 'add', '--repo', repo, '--id', 'app', '--path', repo, '--stack', 'node',
    ]);
    assert.strictEqual(result.status, 0, output(result));
    const doc = workspaces(repo);
    const entry = doc.workspaces[0];
    assert.strictEqual(entry.path, '.');
    assert.strictEqual(entry.stack, 'node');
    assert.strictEqual(entry.vcs, 'git');
    assert.strictEqual(entry.versioning, 'package.json');
    assert.deepStrictEqual(entry.conventions, ['AGENTS.md']);
    assert.strictEqual(slot(repo, 'unit').command, 'npm test');
    assert.strictEqual(slot(repo, 'unit').absent, false);
    assert.strictEqual(slot(repo, 'lint').absent, true);
    const body = JSON.stringify(doc);
    assert(!body.includes(repo));
    assert(!body.includes('do-not-guess'));
    assert(!body.includes('local rules'));
    assert(!body.includes('Do Not Guess'));
    assert.strictEqual(entry.dirty, undefined);
    assert.strictEqual(entry.worktree_hash, undefined);
    const leaks = walk(TOOL_ROOT, { skip: ['.git', 'node_modules', '.sdd-dev'] }).filter((rel) => {
      const bytes = fs.readFileSync(path.join(TOOL_ROOT, rel));
      return bytes.includes(repo);
    });
    assert.deepStrictEqual(leaks, []);
  });

  test('AC-P3-3 run start marks unit absent with a reason and does not call it pass', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    const started = start(repo);
    const unit = slot(repo, 'unit');
    assert.strictEqual(unit.absent, true);
    assert.strictEqual(unit.command, null);
    assert.match(unit.reason, /no unit test command/);
    assert.strictEqual(unit.cwd, '.');
    const profile = JSON.stringify(workspaces(repo));
    assert(!profile.includes('pass'));
    assert(!started.output.includes('pass'));
    assert.strictEqual(manifest(repo, started.id).workspaces[0].baseline.dirty !== undefined, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(workspaces(repo).workspaces[0], 'baseline'), false);
  });

  test('AC-P3-2 an unchanged npm test survives run start while the new baseline head moves', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
      name: 'app',
      scripts: { test: 'node test.js' },
    })}\n`);
    commit(repo, ['docs/need.md', 'package.json'], 'init');
    install(repo);
    const added = sdd([
      'workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node',
    ]);
    assert.strictEqual(added.status, 0, output(added));
    const file = path.join(repo, '.sdd-dev', 'config', 'workspaces.json');
    const before = fs.readFileSync(file, 'utf8');
    const verifyBefore = JSON.stringify(readJson(file).workspaces[0].verify);
    const first = start(repo);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(JSON.stringify(readJson(file).workspaces[0].verify), verifyBefore);
    const head1 = manifest(repo, first.id).workspaces[0].baseline.codebase_ref.head;
    assert.strictEqual(head1, head(repo));
    fs.writeFileSync(path.join(repo, 'README.md'), 'next\n');
    commit(repo, ['README.md'], 'next');
    const second = start(repo);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(JSON.stringify(readJson(file).workspaces[0].verify), verifyBefore);
    const head2 = manifest(repo, second.id).workspaces[0].baseline.codebase_ref.head;
    assert.strictEqual(head2, head(repo));
    assert.notStrictEqual(head2, head1);
  });

  test('package.json beats Makefile, and refresh keeps outputs until the command changes', () => {
    const repo = tmpRepo();
    install(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
      scripts: { test: 'node test.js' },
    })}\n`);
    fs.writeFileSync(path.join(repo, 'Makefile'), 'test:\n\techo test\nlint:\n\techo lint\n');
    const added = sdd([
      'workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node',
    ]);
    assert.strictEqual(added.status, 0, output(added));
    assert.strictEqual(slot(repo, 'unit').command, 'npm test');
    assert.strictEqual(slot(repo, 'lint').command, 'make lint');
    const file = path.join(repo, '.sdd-dev', 'config', 'workspaces.json');
    const doc = readJson(file);
    const unit = doc.workspaces[0].verify.find((item) => item.id === 'unit');
    unit.outputs = ['dist/'];
    unit.limitation = 'flaky on fridays';
    unit.known_failures = ['adds'];
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    const refreshed = sdd(['workspace', 'refresh', '--repo', repo, '--id', 'app']);
    assert.strictEqual(refreshed.status, 0, output(refreshed));
    assert.deepStrictEqual(slot(repo, 'unit').outputs, ['dist/']);
    assert.strictEqual(slot(repo, 'unit').limitation, 'flaky on fridays');
    assert.deepStrictEqual(slot(repo, 'unit').known_failures, ['adds']);
    fs.unlinkSync(path.join(repo, 'package.json'));
    fs.writeFileSync(path.join(repo, 'Makefile'), 'lint:\n\techo lint\n');
    const again = sdd(['workspace', 'refresh', '--repo', repo, '--id', 'app']);
    assert.strictEqual(again.status, 0, output(again));
    assert.strictEqual(slot(repo, 'unit').absent, true);
    assert.deepStrictEqual(slot(repo, 'unit').outputs, []);
    assert.strictEqual(slot(repo, 'unit').limitation, null);
    assert.deepStrictEqual(slot(repo, 'unit').known_failures, []);
    assert.strictEqual(slot(repo, 'lint').command, 'make lint');
  });

  test('run start changes only command fields and keeps user outputs', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ scripts: { test: 'node test.js' } })}\n`);
    const added = sdd([
      'workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node',
    ]);
    assert.strictEqual(added.status, 0, output(added));
    const file = path.join(repo, '.sdd-dev', 'config', 'workspaces.json');
    const doc = readJson(file);
    const unit = doc.workspaces[0].verify.find((item) => item.id === 'unit');
    unit.outputs = ['coverage/'];
    unit.known_failures = ['adds'];
    unit.limitation = 'keep';
    const stamp = doc.workspaces[0].profile_generated_at;
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    fs.unlinkSync(path.join(repo, 'package.json'));
    start(repo);
    const next = slot(repo, 'unit');
    assert.strictEqual(next.absent, true);
    assert.strictEqual(next.command, null);
    assert.match(next.reason, /no unit test command/);
    assert.deepStrictEqual(next.outputs, ['coverage/']);
    assert.deepStrictEqual(next.known_failures, ['adds']);
    assert.strictEqual(next.limitation, 'keep');
    assert.notStrictEqual(workspaces(repo).workspaces[0].profile_generated_at, stamp);
    assert.strictEqual(slot(repo, 'lint').absent, true);
  });

  test('a path outside the repo is rejected', () => {
    const repo = tmpRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p3-out-'));
    install(repo);
    const result = sdd([
      'workspace', 'add', '--repo', repo, '--id', 'app', '--path', outside, '--stack', 'node',
    ]);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /escapes the repo/);
  });

  test('pyproject, Cargo.toml, and go.mod map to one unit command by priority', () => {
    const repo = tmpRepo();
    install(repo);
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[package]\nname = "x"\n');
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/x\n');
    fs.writeFileSync(path.join(repo, 'Makefile'), 'test:\n\techo test\n');
    const result = sdd([
      'workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'py',
    ]);
    assert.strictEqual(result.status, 0, output(result));
    assert.strictEqual(slot(repo, 'unit').command, 'pytest');
    assert.strictEqual(workspaces(repo).workspaces[0].stack, 'py');
    assert.strictEqual(workspaces(repo).workspaces[0].versioning, 'none');
  });
};
