'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson } = require('../lib/fsutil');
const { contentHash } = require('../lib/hash');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');

function sdd(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function git(repo, args) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function commitAll(repo, message) {
  const added = git(repo, ['add', '-A']);
  assert.strictEqual(added.status, 0, added.stderr);
  const committed = git(repo, [
    '-c', `user.email=${['dev@', 'example.com'].join('')}`,
    '-c', 'user.name=dev',
    'commit', '-q', '-m', message,
  ]);
  assert.strictEqual(committed.status, 0, `${committed.stdout}${committed.stderr}`);
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p11-')));
  git(repo, ['init', '-q']);
  return repo;
}

function install(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

function startAdvisors(repo) {
  const result = sdd([
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'selected_advisors', '--source', 'docs/need.md',
  ]);
  assert.strictEqual(result.status, 0, output(result));
  const match = result.stdout.match(/^run (\S+)/m);
  assert(match, output(result));
  return match[1];
}

function prepareDirty(contents) {
  const repo = tmpRepo();
  install(repo);
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), contents);
  commitAll(repo, 'init');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), `${contents}dirty\n`);
  const id = startAdvisors(repo);
  const run = path.join(repo, '.sdd-dev', 'runs', id);
  return { repo, id, run };
}

module.exports = function p11Tests(test) {
  test('AC-P11-7 a baseline-dirty file is clean until its content changes again', () => {
    const original = 'export {}\n';
    const { repo, run } = prepareDirty(original);
    const baseline = readJson(path.join(run, 'manifest.json')).workspaces[0].baseline;
    const dirtyBody = fs.readFileSync(path.join(repo, 'src', 'a.ts'));
    assert.deepStrictEqual(baseline.dirty, ['src/a.ts']);
    assert.strictEqual(baseline.dirty_hashes['src/a.ts'], contentHash(dirtyBody));

    const same = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(same.status, 0, output(same));
    assert.doesNotMatch(output(same), /越界/);
    assert.doesNotMatch(output(same), /dirty_hashes missing/);

    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const n = 2;\n');
    const edited = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(edited.status, 1, output(edited));
    assert.match(edited.stderr, /越界 src\/a\.ts/);

    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), dirtyBody);
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
    const added = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(added.status, 1, output(added));
    assert.match(added.stderr, /越界 src\/b\.ts/);
    assert.doesNotMatch(added.stderr, /越界 src\/a\.ts/);
  });

  test('AC-P11-8 a manifest without dirty_hashes treats baseline dirty files as a new diff', () => {
    const { repo, run } = prepareDirty('export {}\n');
    const manifest = readJson(path.join(run, 'manifest.json'));
    delete manifest.workspaces[0].baseline.dirty_hashes;
    writeJson(path.join(run, 'manifest.json'), manifest);
    const result = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(result.stderr, /越界 src\/a\.ts/);
    assert.match(result.stdout, /note baseline dirty_hashes missing; treating baseline dirty files as a new diff/);
  });
};