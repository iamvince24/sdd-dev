'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson, walk } = require('../lib/fsutil');
const { revisionHash } = require('../lib/revision');
const { contentHash } = require('../lib/hash');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');
const AKIA = 'AKIAIOSFODNN7EXAMPLE';
const BEARER = 'super-secret-token';

function sdd(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p2-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function commit(repo, files, message) {
  const added = spawnSync('git', ['add', '--', ...files], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(added.status, 0, added.stderr);
  const committed = spawnSync('git', [
    '-c', 'user.email=dev@example.com',
    '-c', 'user.name=dev',
    'commit', '-q', '-m', message,
  ], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(committed.status, 0, `${committed.stdout}${committed.stderr}`);
}

function head(repo) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
}

function porcelain(repo) {
  return spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repo,
    encoding: 'utf8',
  }).stdout;
}

function install(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

function writeNeed(repo, body = 'need\n') {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), body);
}

function start(repo, extra = [], options) {
  const result = sdd([
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'direct', ...extra,
  ], options);
  assert.strictEqual(result.status, 0, output(result));
  const match = result.stdout.match(/^run (\S+)/m);
  assert(match, output(result));
  return match[1];
}

function manifestPath(repo, id) {
  return path.join(repo, '.sdd-dev', 'runs', id, 'manifest.json');
}

function runPath(repo, id) {
  return path.join(repo, '.sdd-dev', 'runs', id);
}

function assertAbsent(dir, secret) {
  for (const rel of walk(dir)) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    assert(!bytes.includes(Buffer.from(secret)), `${rel} still contains ${secret}`);
  }
}

module.exports = function p2Tests(test) {
  test('run start stubs a missing workspace and leaves verify[] untouched', () => {
    const fresh = tmpRepo();
    writeNeed(fresh);
    install(fresh);
    start(fresh, ['--source', 'docs/need.md']);
    const stub = readJson(path.join(fresh, '.sdd-dev', 'config', 'workspaces.json'));
    assert.deepStrictEqual(stub.workspaces, [{ id: 'app', path: '.', vcs: 'git' }]);
    assert(!JSON.stringify(stub).includes(fresh));

    const existing = tmpRepo();
    writeNeed(existing);
    install(existing);
    const file = path.join(existing, '.sdd-dev', 'config', 'workspaces.json');
    const body = `${JSON.stringify({
      workspaces: [{ id: 'app', path: '.', vcs: 'git', verify: [{ id: 'unit', command: 'npm test' }] }],
    }, null, 2)}\n`;
    fs.writeFileSync(file, body);
    start(existing, ['--source', 'docs/need.md']);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), body);
  });

  test('AC-P2-1 check fails when a frozen revision changes and does not rewrite the approval', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    const id = start(repo, ['--source', 'docs/need.md']);
    const run = runPath(repo, id);
    const revision = path.join(run, 'spec', 'revisions', 'r1.md');
    fs.mkdirSync(path.dirname(revision), { recursive: true });
    fs.writeFileSync(revision, '---\nartifact: execution-spec\nrevision: 1\ncontent_hash: ""\n---\n\nGiven a run.\n');
    const approval = path.join(run, 'approvals', 'spec.json');
    writeJson(approval, {
      artifact: 'execution-spec',
      revision: 1,
      content_hash: revisionHash(fs.readFileSync(revision)),
      approved_at: '2026-09-26T00:00:00.000Z',
      carried_from: null,
    });
    const approvalBefore = fs.readFileSync(approval);
    const manifestBefore = fs.readFileSync(manifestPath(repo, id));
    fs.writeFileSync(revision, fs.readFileSync(revision, 'utf8').replace('Given', 'Givne'));
    const result = sdd(['check', '--repo', repo]);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /spec\/revisions\/r1\.md hash mismatch/);
    assert.deepStrictEqual(fs.readFileSync(approval), approvalBefore);
    assert.deepStrictEqual(fs.readFileSync(manifestPath(repo, id)), manifestBefore);
  });

  test('AC-P2-2 baseline keeps the old head, reports the new one, and marks evidence stale', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'v1\n');
    commit(repo, ['docs/need.md', 'README.md'], 'init');
    install(repo);
    const id = start(repo, ['--source', 'docs/need.md']);
    const h1 = head(repo);
    const evidence = sdd(['evidence', 'write', '--repo', repo, '--ac', 'AC-1'], { input: 'ok\n' });
    assert.strictEqual(evidence.status, 0, output(evidence));
    fs.writeFileSync(path.join(repo, 'README.md'), 'v2\n');
    commit(repo, ['README.md'], 'next');
    const h2 = head(repo);
    assert.notStrictEqual(h1, h2);
    const result = sdd(['run', 'baseline', '--repo', repo]);
    assert.strictEqual(result.status, 0, output(result));
    assert.match(result.stdout, new RegExp(`current head ${h2}`));
    const manifest = readJson(manifestPath(repo, id));
    assert.strictEqual(manifest.workspaces[0].baseline.codebase_ref.head, h1);
    assert.strictEqual(manifest.drift.workspaces[0].current_head, h2);
    const meta = readJson(path.join(runPath(repo, id), 'evidence', 'AC-1', 'meta.json'));
    assert.strictEqual(meta.stale, true);
    assert.strictEqual(meta.stale_reason, 'codebase_ref');
  });

  test('AC-P2-3 evidence writes redact secret shapes and the original is not in the run', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    const id = start(repo, ['--source', 'docs/need.md']);
    const result = sdd(['evidence', 'write', '--repo', repo, '--ac', 'AC-1'], {
      input: `Authorization: Bearer ${BEARER}\n${AKIA}\n`,
    });
    assert.strictEqual(result.status, 0, output(result));
    const body = fs.readFileSync(path.join(runPath(repo, id), 'evidence', 'AC-1', 'output.txt'), 'utf8');
    assert.match(body, /\[redacted\]/);
    assert.doesNotMatch(body, /Authorization: Bearer super/);
    const run = runPath(repo, id);
    assertAbsent(run, AKIA);
    assertAbsent(run, BEARER);
    assert.match(fs.readFileSync(path.join(run, 'problems.md'), 'utf8'), /## P-1/);
  });

  test('AC-P2-4 a second content change marks evidence stale while porcelain stays the same', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v1\n');
    commit(repo, ['docs/need.md', 'tracked.txt'], 'init');
    install(repo);
    const id = start(repo, ['--source', 'docs/need.md']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n');
    const evidence = sdd(['evidence', 'write', '--repo', repo, '--ac', 'AC-1'], { input: 'saw v2\n' });
    assert.strictEqual(evidence.status, 0, output(evidence));
    const before = porcelain(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v3\n');
    const after = porcelain(repo);
    assert.strictEqual(before, after);
    assert.match(before, /tracked\.txt/);
    const result = sdd(['run', 'baseline', '--repo', repo]);
    assert.strictEqual(result.status, 0, output(result));
    const meta = readJson(path.join(runPath(repo, id), 'evidence', 'AC-1', 'meta.json'));
    assert.strictEqual(meta.stale, true);
    assert.notStrictEqual(meta.codebase_ref.worktree_hash, '');
  });

  test('AC-P2-5 resume reports a changed source and the revision that cited it', () => {
    const repo = tmpRepo();
    writeNeed(repo, 'original\n');
    install(repo);
    const id = start(repo, ['--source', 'docs/need.md']);
    const manifest = readJson(manifestPath(repo, id));
    const sourceId = manifest.sources[0].id;
    const run = runPath(repo, id);
    const revision = path.join(run, 'spec', 'revisions', 'r1.md');
    fs.mkdirSync(path.dirname(revision), { recursive: true });
    fs.writeFileSync(revision, [
      '---',
      'artifact: execution-spec',
      'revision: 1',
      'content_hash: ""',
      'source_refs:',
      '  - path: docs/need.md',
      `    id: ${sourceId}`,
      '---',
      '',
      'Need',
      '',
    ].join('\n'));
    const approval = path.join(run, 'approvals', 'spec.json');
    writeJson(approval, {
      artifact: 'execution-spec',
      revision: 1,
      content_hash: revisionHash(fs.readFileSync(revision)),
    });
    const approvalBefore = fs.readFileSync(approval);
    fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'changed\n');
    const result = sdd(['run', 'resume', id, '--repo', repo]);
    assert.strictEqual(result.status, 0, output(result));
    assert.match(result.stdout, /docs\/need\.md/);
    assert.match(result.stdout, new RegExp(contentHash(fs.readFileSync(path.join(repo, 'docs', 'need.md')))));
    assert.match(result.stdout, /spec\/revisions\/r1\.md/);
    assert.strictEqual(readJson(manifestPath(repo, id)).sources[0].id, sourceId);
    assert.deepStrictEqual(fs.readFileSync(approval), approvalBefore);
  });

  test('AC-P2-6 a force_push grant for feature/x does not cover main', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    start(repo, ['--source', 'docs/need.md']);
    const added = sdd(['grant', 'add', '--repo', repo, '--op', 'force_push', '--scope', 'feature/x', '--source', 'Q-1']);
    assert.strictEqual(added.status, 0, output(added));
    const miss = sdd(['grant', 'check', '--repo', repo, '--op', 'force_push', '--scope', 'main']);
    assert.strictEqual(miss.status, 1, output(miss));
    assert.match(output(miss), /force_push main/);
    const hit = sdd(['grant', 'check', '--repo', repo, '--op', 'force_push', '--scope', 'feature/x']);
    assert.strictEqual(hit.status, 0, output(hit));
  });

  test('AC-P2-7 stdin input is stored under sources/ and hashed in the manifest', () => {
    const repo = tmpRepo();
    install(repo);
    const body = 'need from stdin\n';
    const id = start(repo, ['--source-stdin'], { input: body });
    const stored = fs.readFileSync(path.join(runPath(repo, id), 'sources', '1.md'));
    assert.strictEqual(stored.toString('utf8'), body);
    const manifest = readJson(manifestPath(repo, id));
    assert.strictEqual(manifest.sources[0].path, 'sources/1.md');
    assert.strictEqual(manifest.sources[0].id, contentHash(Buffer.from(body)));
    assert.strictEqual(manifest.sources[0].origin, 'stdin');
  });

  test('AC-P2-8 export redacts secret shapes in the archive', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    const id = start(repo, ['--source', 'docs/need.md']);
    fs.writeFileSync(path.join(runPath(repo, id), 'leak.md'), `token ${AKIA}\n`);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p2-out-')), 'run.tar');
    const result = sdd(['run', 'export', id, '--repo', repo, '--out', out]);
    assert.strictEqual(result.status, 0, output(result));
    const packed = fs.readFileSync(out);
    assert(packed.includes(Buffer.from('[redacted]')));
    assert(!packed.includes(Buffer.from(AKIA)));
  });
};
