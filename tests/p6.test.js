'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson } = require('../lib/fsutil');
const { computeCodebase } = require('../lib/codebase');
const { revisionHash } = require('../lib/revision');
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

function start(repo, route = 'direct') {
  const result = sdd([
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', route, '--source', 'docs/need.md',
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

  test('AC-P6-11 and AC-P3-4 new product paths must sit in task paths or verify outputs', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'v1\n');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export {}\n');
    commit(repo, ['docs/need.md', 'README.md', 'src/a.ts'], 'init');
    fs.writeFileSync(path.join(repo, 'README.md'), 'v1 dirty\n');
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    const id = start(repo);
    const run = runPath(repo, id);
    const plan = [
      '---',
      'artifact: plan',
      'revision: 1',
      '---',
      '',
      '<!-- sec:tasks -->',
      '- id: T-1',
      '  paths: src/a.ts',
      '',
    ].join('\n');
    fs.mkdirSync(path.join(run, 'plan', 'revisions'), { recursive: true });
    fs.writeFileSync(path.join(run, 'plan', 'plan.md'), plan);
    fs.writeFileSync(path.join(run, 'plan', 'revisions', 'r1.md'), plan);
    writeJson(path.join(run, 'approvals', 'plan.json'), {
      artifact: 'plan',
      revision: 1,
      content_hash: revisionHash(Buffer.from(plan)),
      auto_commit: false,
    });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const n = 1;\n');
    fs.writeFileSync(path.join(repo, '.sdd-dev', 'scratch.txt'), 'tool\n');
    const allowed = readJson(path.join(run, 'manifest.json'));
    allowed.implementation_authorized = true;
    writeJson(path.join(run, 'manifest.json'), allowed);
    const inside = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(inside.status, 0, output(inside));
    assert.doesNotMatch(output(inside), /越界/);
    assert.doesNotMatch(output(inside), /route_reassess/);
    const historyBefore = readJson(path.join(run, 'manifest.json')).route_history.length;

    fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'extra.ts'), 'export {}\n');
    fs.writeFileSync(path.join(repo, 'lib', 'nope.js'), 'module.exports = {}\n');
    const manifest = readJson(path.join(run, 'manifest.json'));
    manifest.modifiers.fast_lane = true;
    writeJson(path.join(run, 'manifest.json'), manifest);
    const outside = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(outside.status, 1, output(outside));
    assert.match(outside.stderr, /越界 lib\/nope\.js/);
    assert.match(outside.stderr, /越界 src\/extra\.ts/);
    assert.doesNotMatch(outside.stderr, /越界 README\.md/);
    assert.doesNotMatch(outside.stderr, /越界 src\/a\.ts/);
    assert.match(outside.stdout, /route_reassess lib\/nope\.js src\/extra\.ts/);
    const after = readJson(path.join(run, 'manifest.json'));
    assert.strictEqual(after.route, 'direct');
    assert.strictEqual(after.route_history.length, historyBefore + 1);
    const entry = after.route_history[after.route_history.length - 1];
    assert.strictEqual(entry.by, 'auto');
    assert.strictEqual(entry.route, 'direct');
    assert.strictEqual(entry.reason, 'route_reassess: lib/nope.js, src/extra.ts');
    assert.strictEqual(entry.modifiers.fast_lane, true);
    assert.strictEqual(entry.modifiers.cross_check, false);
    const frozen = fs.readFileSync(path.join(run, 'manifest.json'));
    const again = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(again.status, 1, output(again));
    assert.deepStrictEqual(fs.readFileSync(path.join(run, 'manifest.json')), frozen);

    patchUnit(repo, { outputs: ['dist/'] });
    fs.rmSync(path.join(repo, 'src', 'extra.ts'));
    fs.rmSync(path.join(repo, 'lib', 'nope.js'));
    fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'dist', 'index.js'), 'ok\n');
    const declared = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(declared.status, 0, output(declared));
    fs.mkdirSync(path.join(repo, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'coverage', 'lcov.info'), 'no\n');
    const missed = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(missed.status, 1, output(missed));
    assert.match(missed.stderr, /越界 coverage\/lcov\.info/);
  });

  function headOf(repo) {
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  }

  function porcelain(repo) {
    return spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
  }

  function prepareRepo(route = 'direct') {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'v1\n');
    commit(repo, ['docs/need.md', 'README.md'], 'init');
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    const id = start(repo, route);
    return { repo, id, run: runPath(repo, id) };
  }

  function putSpecPlan(run, { paths = 'src/a.js', status = 'pending', method = 'manual' } = {}) {
    const spec = '---\nartifact: execution-spec\nrevision: 1\n---\n\n<!-- sec:acceptance -->\n- id: AC-1\n  requirement: R-1\n';
    fs.mkdirSync(path.join(run, 'spec', 'revisions'), { recursive: true });
    fs.writeFileSync(path.join(run, 'spec', 'execution-spec.md'), spec);
    fs.writeFileSync(path.join(run, 'spec', 'revisions', 'r1.md'), spec);
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
    const plan = [
      '---',
      'artifact: plan',
      'revision: 1',
      'based_on:',
      '  artifact: execution-spec',
      '  revision: 1',
      `  content_hash: ${hash}`,
      '---',
      '',
      '<!-- sec:tasks -->',
      '- id: T-1',
      `  paths: ${paths}`,
      '  acceptance: AC-1',
      '  commit: add the button',
      `  status: ${status}`,
      '',
      '<!-- sec:verification -->',
      '- id: AC-1',
      `  method: ${method}`,
      '',
    ].join('\n');
    fs.mkdirSync(path.join(run, 'plan', 'revisions'), { recursive: true });
    fs.writeFileSync(path.join(run, 'plan', 'plan.md'), plan);
    fs.writeFileSync(path.join(run, 'plan', 'revisions', 'r1.md'), plan);
    return { hash, plan };
  }

  function approvePlan(run, plan, hash, autoCommit) {
    const doc = {
      artifact: 'plan',
      revision: 1,
      content_hash: revisionHash(Buffer.from(plan)),
      based_on_spec: { revision: 1, content_hash: hash },
      approved_at: '2026-09-26T00:00:00.000Z',
      carried_from: null,
      auto_commit: autoCommit,
    };
    if (autoCommit === undefined) delete doc.auto_commit;
    writeJson(path.join(run, 'approvals', 'plan.json'), doc);
  }

  function passEvidence(repo, id) {
    const ref = computeCodebase(repo, '.').codebase_ref;
    const dir = path.join(runPath(repo, id), 'evidence', 'AC-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'output.txt'), 'ok\n');
    writeJson(path.join(dir, 'meta.json'), {
      ac: 'AC-1',
      status: 'pass',
      stale: false,
      preexisting: false,
      codebase_ref: ref,
    });
  }

  function putResult(run, extra = {}) {
    const lines = [
      '---',
      'artifact: result-review',
      'revision: 1',
      `verdict: ${extra.verdict || 'READY'}`,
      `reviewer_kind: ${extra.reviewer_kind || 'human'}`,
    ];
    if (extra.independent !== undefined) lines.push(`independent: ${extra.independent}`);
    if (extra.context_id) lines.push(`context_id: ${extra.context_id}`);
    lines.push('---', '');
    const file = path.join(run, 'review', 'result-review-r1.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
  }

  test('AC-P6-5 auto_commit false or missing rejects commit and leaves git log alone', () => {
    const { repo, id, run } = prepareRepo();
    const { hash, plan } = putSpecPlan(run);
    approvePlan(run, plan, hash, false);
    fs.writeFileSync(path.join(repo, 'src-note.txt'), 'x\n');
    spawnSync('git', ['add', '--', 'src-note.txt'], { cwd: repo });
    const before = headOf(repo);
    const tree = porcelain(repo);
    const rejected = sdd(['commit', '--task', 'T-1', '--repo', repo]);
    assert.strictEqual(rejected.status, 1, output(rejected));
    assert.match(output(rejected), /auto_commit is not true/);
    assert.strictEqual(headOf(repo), before);
    assert.strictEqual(porcelain(repo), tree);

    const doc = readJson(path.join(run, 'approvals', 'plan.json'));
    delete doc.auto_commit;
    writeJson(path.join(run, 'approvals', 'plan.json'), doc);
    const missing = sdd(['commit', '--task', 'T-1', '--repo', repo]);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /auto_commit is not true/);
    assert.strictEqual(headOf(repo), before);
    assert.strictEqual(porcelain(repo), tree);
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).run_id, id);
  });

  test('AC-P6-6 a staged path outside the task is rejected and the index stays', () => {
    const { repo, run } = prepareRepo();
    const { hash, plan } = putSpecPlan(run);
    approvePlan(run, plan, hash, true);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
    fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'b\n');
    spawnSync('git', ['add', '--', 'src/a.js', 'src/b.js'], { cwd: repo });
    passEvidence(repo, readJson(path.join(run, 'manifest.json')).run_id);
    const before = headOf(repo);
    const tree = porcelain(repo);
    const rejected = sdd(['commit', '--task', 'T-1', '--repo', repo]);
    assert.strictEqual(rejected.status, 1, output(rejected));
    assert.match(output(rejected), /src\/b\.js is outside T-1/);
    assert.strictEqual(headOf(repo), before);
    assert.strictEqual(porcelain(repo), tree);
  });

  test('AC-P6-12 a baseline-dirty file that is changed again is not committed', () => {
    const { repo, run } = prepareRepo();
    const { hash, plan } = putSpecPlan(run);
    approvePlan(run, plan, hash, true);
    const manifest = readJson(path.join(run, 'manifest.json'));
    manifest.workspaces[0].baseline.dirty = ['src/a.js'];
    writeJson(path.join(run, 'manifest.json'), manifest);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'changed\n');
    spawnSync('git', ['add', '--', 'src/a.js'], { cwd: repo });
    passEvidence(repo, manifest.run_id);
    const before = headOf(repo);
    const tree = porcelain(repo);
    const rejected = sdd(['commit', '--task', 'T-1', '--repo', repo]);
    assert.strictEqual(rejected.status, 1, output(rejected));
    assert.match(output(rejected), /src\/a\.js was already dirty at baseline/);
    assert.strictEqual(headOf(repo), before);
    assert.strictEqual(porcelain(repo), tree);
  });

  test('AC-P6-7 commit adds one commit whose parent is the old HEAD and does not touch the remote', () => {
    const { repo, run } = prepareRepo();
    const { hash, plan } = putSpecPlan(run);
    approvePlan(run, plan, hash, true);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
    fs.writeFileSync(path.join(repo, 'other.js'), 'leave\n');
    spawnSync('git', ['add', '--', 'src/a.js'], { cwd: repo });
    passEvidence(repo, readJson(path.join(run, 'manifest.json')).run_id);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-remote-'));
    spawnSync('git', ['init', '--bare', '-q', bare]);
    spawnSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
    spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: repo });
    const remoteBefore = spawnSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare, encoding: 'utf8' }).stdout.trim();
    const before = headOf(repo);
    const committed = sdd(['commit', '--task', 'T-1', '--repo', repo]);
    assert.strictEqual(committed.status, 0, output(committed));
    const after = headOf(repo);
    assert.notStrictEqual(after, before);
    assert.strictEqual(headOf(repo) && spawnSync('git', ['rev-parse', 'HEAD^'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), before);
    assert.strictEqual(spawnSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), 'add the button');
    assert.match(spawnSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout, /src\/a\.js/);
    assert.doesNotMatch(spawnSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout, /other\.js/);
    assert.strictEqual(spawnSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare, encoding: 'utf8' }).stdout.trim(), remoteBefore);
    assert.match(porcelain(repo), /other\.js/);
  });

  test('AC-P6-8 and AC-P6-9 done requires an independent result review and rejects the executor context', () => {
    const direct = prepareRepo();
    putSpecPlan(direct.run);
    passEvidence(direct.repo, direct.id);
    const finished = sdd(['run', 'done', '--repo', direct.repo]);
    assert.strictEqual(finished.status, 0, output(finished));
    assert.strictEqual(readJson(path.join(direct.run, 'manifest.json')).status, 'done');

    const checked = prepareRepo();
    putSpecPlan(checked.run);
    passEvidence(checked.repo, checked.id);
    const manifest = readJson(path.join(checked.run, 'manifest.json'));
    manifest.modifiers.cross_check = true;
    writeJson(path.join(checked.run, 'manifest.json'), manifest);
    const needsReview = sdd(['run', 'done', '--repo', checked.repo]);
    assert.strictEqual(needsReview.status, 1, output(needsReview));
    assert.match(output(needsReview), /result review is missing/);
    assert.strictEqual(readJson(path.join(checked.run, 'manifest.json')).status, 'active');

    const full = prepareRepo('full_pipeline');
    putSpecPlan(full.run);
    passEvidence(full.repo, full.id);
    const missing = sdd(['run', 'done', '--repo', full.repo]);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /result review is missing/);
    assert.strictEqual(readJson(path.join(full.run, 'manifest.json')).status, 'active');
    putResult(full.run, { reviewer_kind: 'agent', independent: 'true', context_id: 'executor-1' });
    fs.mkdirSync(path.join(full.run, 'context'), { recursive: true });
    writeJson(path.join(full.run, 'context', 'executor.json'), { role: 'executor', context_id: 'executor-1', items: [] });
    const same = sdd(['run', 'done', '--repo', full.repo]);
    assert.strictEqual(same.status, 1, output(same));
    assert.match(output(same), /context_id equals the executor/);
    assert.strictEqual(readJson(path.join(full.run, 'manifest.json')).status, 'active');
    putResult(full.run, { reviewer_kind: 'agent', independent: 'true', context_id: 'reviewer-1' });
    const ready = sdd(['run', 'done', '--repo', full.repo]);
    assert.strictEqual(ready.status, 0, output(ready));
    assert.strictEqual(readJson(path.join(full.run, 'manifest.json')).status, 'done');

    const once = prepareRepo('full_pipeline');
    putSpecPlan(once.run);
    passEvidence(once.repo, once.id);
    const onceManifest = readJson(path.join(once.run, 'manifest.json'));
    onceManifest.modifiers.cross_check = true;
    writeJson(path.join(once.run, 'manifest.json'), onceManifest);
    putResult(once.run);
    const shared = sdd(['run', 'done', '--repo', once.repo]);
    assert.strictEqual(shared.status, 0, output(shared));
    assert.strictEqual(fs.readdirSync(path.join(once.run, 'review')).length, 1);

    const human = prepareRepo();
    putSpecPlan(human.run);
    passEvidence(human.repo, human.id);
    const humanManifest = readJson(path.join(human.run, 'manifest.json'));
    humanManifest.modifiers.no_delegation = true;
    humanManifest.modifiers.cross_check = true;
    writeJson(path.join(human.run, 'manifest.json'), humanManifest);
    putResult(human.run, { reviewer_kind: 'agent', independent: 'true', context_id: 'reviewer-1' });
    const agent = sdd(['run', 'done', '--repo', human.repo]);
    assert.strictEqual(agent.status, 1, output(agent));
    assert.match(output(agent), /cannot be independent under no_delegation/);
    assert.match(output(agent), /pending_human/);
    assert.strictEqual(readJson(path.join(human.run, 'manifest.json')).status, 'active');
    putResult(human.run, { reviewer_kind: 'human' });
    const person = sdd(['run', 'done', '--repo', human.repo]);
    assert.strictEqual(person.status, 0, output(person));
    assert.strictEqual(readJson(path.join(human.run, 'manifest.json')).status, 'done');
  });

  test('a failing acceptance stays unfinished in the report, and done does not treat that sentence as status', () => {
    const { repo, id, run } = prepareRepo();
    putSpecPlan(run, { method: 'unit' });
    patchUnit(repo, { command: "node -e 'process.exit(1)'", absent: false, reason: null, known_failures: [] });
    const verified = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(verified.status, 0, output(verified));
    assert.match(completion(repo, id), /\n未完成\n/);
    const report = fs.readFileSync(path.join(run, 'report.md'), 'utf8');
    assert.match(report, /## 證據路徑\n\n- AC-1: evidence\/AC-1\//);
    assert.match(report, /## 沿用核准\n\n- 無/);
    assert.match(report, /## 能力缺口\n\n- delegate convention/);
    assert.match(report, /- 各任務自己的檢查: AC-1 fail/);
    assert.match(report, /- 整合檢查: 無/);
    assert.match(report, /- 最終驗收: 未完成/);
    assert.match(report, /## 建議 commit\n\n- T-1: src\/a\.js\n {2}message: add the button/);
    const stopped = sdd(['run', 'done', '--repo', repo]);
    assert.strictEqual(stopped.status, 1, output(stopped));
    assert.match(output(stopped), /AC-1 is fail/);
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).status, 'active');
    assert.match(completion(repo, id), /\n未完成\n/);
    assert.doesNotMatch(completion(repo, id).split('## 證據路徑')[0], /\n完成\n/);
  });

  test('deferred items need a reason, and capability gaps are listed in the report', () => {
    const { repo, id, run } = prepareRepo();
    putSpecPlan(run, { status: 'deferred' });
    passEvidence(repo, id);
    const verified = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(verified.status, 0, output(verified));
    const deferred = fs.readFileSync(path.join(run, 'report.md'), 'utf8').split('## 延後')[1].split('## ')[0];
    assert.match(deferred, /- 無/);
    assert.doesNotMatch(deferred, /T-1/);
    const blocked = sdd(['check', '--repo', repo]);
    assert.strictEqual(blocked.status, 1, output(blocked));
    assert.match(output(blocked), /T-1 is deferred without a reason/);

    const plan = fs.readFileSync(path.join(run, 'plan', 'plan.md'), 'utf8').replace('status: deferred', 'status: deferred\n  reason: waiting on the schema');
    fs.writeFileSync(path.join(run, 'plan', 'plan.md'), plan);
    const manifest = readJson(path.join(run, 'manifest.json'));
    manifest.capability_limits = [{ op: 'delegate', layer: 'convention', gap: 'no separate context' }];
    writeJson(path.join(run, 'manifest.json'), manifest);
    const again = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(again.status, 0, output(again));
    const text = fs.readFileSync(path.join(run, 'report.md'), 'utf8');
    assert.match(text.split('## 延後')[1], /- T-1: waiting on the schema/);
    assert.match(text, /delegate convention no separate context/);
    assert.strictEqual(sdd(['check', '--repo', repo]).status, 0);
  });

  test('a task directory prefix covers files underneath it', () => {
    const repo = tmpRepo();
    writeNeed(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'v1\n');
    commit(repo, ['docs/need.md', 'README.md'], 'init');
    install(repo);
    const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
    assert.strictEqual(added.status, 0, output(added));
    const id = start(repo);
    const plan = path.join(runPath(repo, id), 'plan');
    fs.mkdirSync(plan, { recursive: true });
    fs.writeFileSync(path.join(plan, 'plan.md'), '---\nartifact: plan\nrevision: 1\n---\n\n<!-- sec:tasks -->\n- id: T-1\n  paths: src\n');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'extra.ts'), 'export {}\n');
    const allowed = readJson(path.join(runPath(repo, id), 'manifest.json'));
    allowed.implementation_authorized = true;
    writeJson(path.join(runPath(repo, id), 'manifest.json'), allowed);
    const result = sdd(['check', '--stage', 'dev', '--repo', repo]);
    assert.strictEqual(result.status, 0, output(result));
  });
};
