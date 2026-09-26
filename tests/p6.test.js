'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson } = require('../lib/fsutil');
const { computeCodebase } = require('../lib/codebase');
const { commandArgv, failureNames } = require('../lib/verify');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');
const BEARER = 'super-secret-token';

function sdd(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p6-')));
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

function install(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

function writeNeed(repo) {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
}

function start(repo) {
  const result = sdd([
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md',
  ]);
  assert.strictEqual(result.status, 0, output(result));
  const match = result.stdout.match(/^run (\S+)/m);
  assert(match, output(result));
  return match[1];
}

function runPath(repo, id) {
  return path.join(repo, '.sdd-dev', 'runs', id);
}

function patchUnit(repo, fields) {
  const file = path.join(repo, '.sdd-dev', 'config', 'workspaces.json');
  const doc = readJson(file);
  const unit = doc.workspaces[0].verify.find((item) => item.id === 'unit');
  Object.assign(unit, fields);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return unit;
}

function writeDocs(repo, id, rows) {
  const run = runPath(repo, id);
  const verification = rows.map((row) => `- id: ${row.id}\n  method: ${row.method}`).join('\n');
  const acceptance = rows.map((row) => `- id: ${row.id}\n  requirement: R-1`).join('\n');
  fs.mkdirSync(path.join(run, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(run, 'spec'), { recursive: true });
  fs.writeFileSync(path.join(run, 'plan', 'plan.md'), `---\nartifact: plan\nrevision: 1\n---\n\n<!-- sec:verification -->\n${verification}\n`);
  fs.writeFileSync(path.join(run, 'spec', 'execution-spec.md'), `---\nartifact: execution-spec\nrevision: 1\n---\n\n<!-- sec:acceptance -->\n${acceptance}\n`);
}

function completion(repo, id) {
  const text = fs.readFileSync(path.join(runPath(repo, id), 'report.md'), 'utf8');
  return text.split('## 完成')[1] || '';
}

function meta(repo, id, ac) {
  return readJson(path.join(runPath(repo, id), 'evidence', ac, 'meta.json'));
}

module.exports = function p6Tests(test) {
  test('failure names are the not ok, FAIL, and FAILED lines, and commands stay argv', () => {
    assert.deepStrictEqual(commandArgv('npm test'), ['npm', 'test']);
    assert.deepStrictEqual(commandArgv('go test ./...'), ['go', 'test', './...']);
    assert.deepStrictEqual(commandArgv("node -e 'process.exit(1)'"), ['node', '-e', 'process.exit(1)']);
    const baseline = failureNames('not ok 1 - adds\nFAIL adds.test.js\ntest adds ... FAILED\n');
    const current = failureNames('not ok 1 - adds\nFAIL adds.test.js\ntest adds ... FAILED\ntest extra ... FAILED\n');
    assert.deepStrictEqual([...baseline], ['not ok 1 - adds', 'FAIL adds.test.js', 'FAILED adds']);
    assert.strictEqual(current.has('FAILED extra'), true);
    assert.strictEqual(failureNames('all good\n').size, 0);
  });

  test('AC-P6-1 a failing command is fail, keeps the exit code, and the report stays unfinished', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    commit(repo, ['docs/need.md'], 'init');
    const id = start(repo);
    patchUnit(repo, { command: "node -e 'process.exit(1)'", absent: false, reason: null, known_failures: [] });
    writeDocs(repo, id, [{ id: 'AC-1', method: 'unit' }]);
    const result = sdd(['verify', '--repo', repo, '--ac', 'AC-1'], {
      env: { ...process.env, CI: 'topsecret-ci-value' },
    });
    assert.strictEqual(result.status, 0, output(result));
    const recorded = meta(repo, id, 'AC-1');
    assert.strictEqual(recorded.status, 'fail');
    assert.strictEqual(recorded.exit_code, 1);
    assert.strictEqual(recorded.command, "node -e 'process.exit(1)'");
    assert.strictEqual(recorded.cwd, '.');
    assert.strictEqual(recorded.source, 'command');
    assert.strictEqual(recorded.preexisting, false);
    assert.strictEqual(recorded.stale, false);
    assert.deepStrictEqual(recorded.env, ['CI']);
    assert.strictEqual(recorded.codebase_ref.head, readJson(path.join(runPath(repo, id), 'manifest.json')).workspaces[0].baseline.codebase_ref.head);
    const evidence = path.join(runPath(repo, id), 'evidence', 'AC-1');
    const body = fs.readFileSync(path.join(evidence, 'output.txt'), 'utf8') + fs.readFileSync(path.join(evidence, 'meta.json'), 'utf8');
    assert(!body.includes('topsecret-ci-value'));
    assert(!body.includes(repo));
    assert.match(fs.readFileSync(path.join(runPath(repo, id), 'report.md'), 'utf8'), /AC-1: fail evidence\/AC-1\//);
    assert.match(completion(repo, id), /\n未完成\n/);
    assert.doesNotMatch(completion(repo, id), /\n完成\n/);
  });

  test('AC-P6-2 manual evidence is not_run until output.txt exists, and a product diff is not a pass', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    commit(repo, ['docs/need.md'], 'init');
    const id = start(repo);
    writeDocs(repo, id, [{ id: 'AC-1', method: 'manual' }, { id: 'AC-2', method: 'manual' }]);
    fs.mkdirSync(path.join(runPath(repo, id), 'evidence', 'AC-1'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src-extra.js'), 'changed\n');
    const empty = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(empty.status, 0, output(empty));
    assert.strictEqual(meta(repo, id, 'AC-1').status, 'not_run');
    assert.match(fs.readFileSync(path.join(runPath(repo, id), 'report.md'), 'utf8'), /AC-1: not_run evidence\/AC-1\//);
    assert.match(completion(repo, id), /\n未完成\n/);
    assert.doesNotMatch(output(empty), /verify AC-1 pass/);

    const wrote = sdd(['evidence', 'write', '--repo', repo, '--ac', 'AC-1'], { input: 'saw it\n' });
    assert.strictEqual(wrote.status, 0, output(wrote));
    const accepted = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(accepted.status, 0, output(accepted));
    assert.strictEqual(meta(repo, id, 'AC-1').status, 'pass');
    assert.strictEqual(meta(repo, id, 'AC-1').source, 'evidence');
    assert.match(completion(repo, id), /\n未完成\n/);
    const wrote2 = sdd(['evidence', 'write', '--repo', repo, '--ac', 'AC-2'], { input: 'saw 2\n' });
    assert.strictEqual(wrote2.status, 0, output(wrote2));
    const both = sdd(['verify', '--repo', repo, '--ac', 'AC-2']);
    assert.strictEqual(both.status, 0, output(both));
    assert.match(completion(repo, id), /\n完成\n/);

    fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need changed\n');
    const again = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(again.status, 0, output(again));
    assert.strictEqual(meta(repo, id, 'AC-1').status, 'pass');
    assert.strictEqual(meta(repo, id, 'AC-1').stale, true);
    assert.match(completion(repo, id), /\n未完成\n/);
    assert.doesNotMatch(completion(repo, id), /\n完成\n/);
  });

  test('an absent unit command is blocked and is not a pass', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    const id = start(repo);
    writeDocs(repo, id, [{ id: 'AC-1', method: 'unit' }]);
    const result = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(result.status, 0, output(result));
    const recorded = meta(repo, id, 'AC-1');
    assert.strictEqual(recorded.status, 'blocked');
    assert.match(recorded.reason, /no unit test command/);
    assert.strictEqual(recorded.exit_code, null);
    assert.strictEqual(fs.existsSync(path.join(runPath(repo, id), 'evidence', 'AC-1', 'output.txt')), false);
    assert.match(output(result), /reason no unit test command/);
    assert.doesNotMatch(output(result), /verify AC-1 pass/);
    assert.match(completion(repo, id), /\n未完成\n/);
  });

  test('verify runs argv without a shell and redacts command output', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    const id = start(repo);
    patchUnit(repo, {
      command: 'node -e process.exit(0) && node -e process.exit(9)',
      absent: false,
      reason: null,
      known_failures: [],
    });
    writeDocs(repo, id, [{ id: 'AC-1', method: 'unit' }]);
    const clean = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(clean.status, 0, output(clean));
    assert.strictEqual(meta(repo, id, 'AC-1').status, 'pass');
    assert.strictEqual(meta(repo, id, 'AC-1').exit_code, 0);

    fs.writeFileSync(path.join(repo, 'leak.js'), `process.stdout.write('Authorization: Bearer ${BEARER}\\n');\nprocess.stderr.write('err-side\\n');\nprocess.exit(1);\n`);
    patchUnit(repo, { command: 'node leak.js', absent: false, reason: null });
    const leaked = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(leaked.status, 0, output(leaked));
    const body = fs.readFileSync(path.join(runPath(repo, id), 'evidence', 'AC-1', 'output.txt'), 'utf8');
    assert.match(body, /\[redacted\]/);
    assert.match(body, /err-side/);
    assert(!body.includes(BEARER));
    assert.match(fs.readFileSync(path.join(runPath(repo, id), 'problems.md'), 'utf8'), /## P-1/);
  });

  test('AC-P6-3 matching baseline failures can be preexisting only with this AC evidence', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'fail.js'), [
      "require('fs').writeFileSync('touched.txt', 'x');",
      "process.stdout.write('not ok 1 - adds\\n');",
      "process.stdout.write('FAIL adds.test.js\\n');",
      "process.stdout.write('test adds ... FAILED\\n');",
      'process.exit(1);',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ scripts: { test: 'node fail.js' } })}\n`);
    commit(repo, ['docs/need.md', 'fail.js', 'package.json'], 'init');
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    patchUnit(repo, { known_failures: ['adds'] });
    const id = start(repo);
    const manifest = readJson(path.join(runPath(repo, id), 'manifest.json'));
    const base = readJson(path.join(runPath(repo, id), 'evidence', 'baseline', 'unit', 'meta.json'));
    assert.strictEqual(base.usable, true);
    assert.strictEqual(base.exit_code, 1);
    assert.deepStrictEqual(base.codebase_ref, manifest.workspaces[0].baseline.codebase_ref);
    assert.notStrictEqual(computeCodebase(repo, '.').codebase_ref.worktree_hash, base.codebase_ref.worktree_hash);
    writeDocs(repo, id, [{ id: 'AC-1', method: 'unit' }]);
    const result = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(result.status, 0, output(result));
    const recorded = meta(repo, id, 'AC-1');
    assert.strictEqual(recorded.status, 'fail');
    assert.strictEqual(recorded.preexisting, true);
    assert.strictEqual(fs.existsSync(path.join(runPath(repo, id), 'evidence', 'AC-1', 'output.txt')), true);
    assert.match(completion(repo, id), /\n未完成\n/);
    assert.doesNotMatch(completion(repo, id), /\n完成\n/);
  });

  test('a dirty baseline is unusable and the AC stays blocked', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } })}\n`);
    commit(repo, ['docs/need.md', 'package.json'], 'init');
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'dirty\n');
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    patchUnit(repo, { known_failures: ['npm test'] });
    const id = start(repo);
    const base = readJson(path.join(runPath(repo, id), 'evidence', 'baseline', 'unit', 'meta.json'));
    assert.strictEqual(base.usable, false);
    assert.strictEqual(base.reason, 'dirty');
    assert.strictEqual(fs.existsSync(path.join(runPath(repo, id), 'evidence', 'baseline', 'unit', 'output.txt')), false);
    writeDocs(repo, id, [{ id: 'AC-1', method: 'unit' }]);
    const result = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(result.status, 0, output(result));
    assert.strictEqual(meta(repo, id, 'AC-1').status, 'blocked');
    assert.strictEqual(meta(repo, id, 'AC-1').reason, 'dirty');
    assert.strictEqual(meta(repo, id, 'AC-1').preexisting, false);
  });

  test('baseline evidence is backfilled from the baseline HEAD, not the dirty worktree', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'tree.js'), [
      "const fs = require('fs');",
      "process.stdout.write(fs.existsSync('extra.txt') ? 'not ok 1 - dirty\\n' : 'not ok 1 - clean\\n');",
      'process.exit(1);',
      '',
    ].join('\n'));
    commit(repo, ['docs/need.md', 'tree.js'], 'init');
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    const id = start(repo);
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'later\n');
    patchUnit(repo, { command: 'node tree.js', absent: false, reason: null, known_failures: ['tree'] });
    writeDocs(repo, id, [{ id: 'AC-1', method: 'unit' }]);
    const result = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(result.status, 0, output(result));
    const baseOut = fs.readFileSync(path.join(runPath(repo, id), 'evidence', 'baseline', 'unit', 'output.txt'), 'utf8');
    const currentOut = fs.readFileSync(path.join(runPath(repo, id), 'evidence', 'AC-1', 'output.txt'), 'utf8');
    assert.match(baseOut, /not ok 1 - clean/);
    assert.doesNotMatch(baseOut, /not ok 1 - dirty/);
    assert.match(currentOut, /not ok 1 - dirty/);
    const manifest = readJson(path.join(runPath(repo, id), 'manifest.json'));
    const base = readJson(path.join(runPath(repo, id), 'evidence', 'baseline', 'unit', 'meta.json'));
    assert.deepStrictEqual(base.codebase_ref, manifest.workspaces[0].baseline.codebase_ref);
    assert.strictEqual(meta(repo, id, 'AC-1').preexisting, false);
    assert.strictEqual(meta(repo, id, 'AC-1').status, 'fail');
  });

  test('AC-P6-4 and AC-P6-10 preexisting without a baseline, or with a new failure name, fails check', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'fail.js'), "const fs = require('fs'); process.stdout.write(fs.readFileSync('fails.txt', 'utf8')); process.exit(1);\n");
    fs.writeFileSync(path.join(repo, 'fails.txt'), 'not ok 1 - adds\n');
    fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ scripts: { test: 'node fail.js' } })}\n`);
    commit(repo, ['docs/need.md', 'fail.js', 'fails.txt', 'package.json'], 'init');
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    patchUnit(repo, { known_failures: ['adds'] });
    const id = start(repo);
    writeDocs(repo, id, [{ id: 'AC-1', method: 'unit' }]);
    fs.writeFileSync(path.join(repo, 'fails.txt'), 'not ok 1 - adds\nnot ok 2 - extra\n');
    const result = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(result.status, 0, output(result));
    assert.strictEqual(meta(repo, id, 'AC-1').status, 'fail');
    assert.strictEqual(meta(repo, id, 'AC-1').preexisting, false);
    const ok = sdd(['check', '--repo', repo]);
    assert.strictEqual(ok.status, 0, output(ok));
    const recorded = meta(repo, id, 'AC-1');
    recorded.preexisting = true;
    fs.writeFileSync(path.join(runPath(repo, id), 'evidence', 'AC-1', 'meta.json'), `${JSON.stringify(recorded, null, 2)}\n`);
    const rejected = sdd(['check', '--repo', repo]);
    assert.strictEqual(rejected.status, 1, output(rejected));
    assert.match(output(rejected), /preexisting is not confirmed/);

    const bare = tmpRepo();
    writeNeed(bare);
    install(bare);
    const bareAdd = sdd(['workspace', 'add', '--repo', bare, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(bareAdd.status, 0, output(bareAdd));
    patchUnit(bare, { known_failures: ['npm test'] });
    const bareId = start(bare);
    const evidence = path.join(runPath(bare, bareId), 'evidence', 'AC-1');
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'output.txt'), 'not ok 1 - adds\n');
    fs.writeFileSync(path.join(evidence, 'meta.json'), `${JSON.stringify({
      ac: 'AC-1', status: 'fail', preexisting: true, stale: false, method: 'unit', command: 'npm test',
    }, null, 2)}\n`);
    const missing = sdd(['check', '--repo', bare]);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /preexisting is not confirmed/);
  });

  test('failures with no extractable names are not preexisting', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } })}\n`);
    commit(repo, ['docs/need.md', 'package.json'], 'init');
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    patchUnit(repo, { known_failures: ['npm test'] });
    const id = start(repo);
    const base = readJson(path.join(runPath(repo, id), 'evidence', 'baseline', 'unit', 'meta.json'));
    assert.strictEqual(base.exit_code, 1);
    assert.strictEqual(base.usable, true);
    writeDocs(repo, id, [{ id: 'AC-1', method: 'unit' }]);
    const result = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(result.status, 0, output(result));
    assert.strictEqual(meta(repo, id, 'AC-1').status, 'fail');
    assert.strictEqual(meta(repo, id, 'AC-1').preexisting, false);
  });
};
