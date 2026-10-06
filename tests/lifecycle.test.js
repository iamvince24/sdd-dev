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

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');

function sdd(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function createRun(route = 'direct', extra = []) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-lifecycle-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
  const init = sdd('init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore');
  assert.strictEqual(init.status, 0, init.stderr);
  const workspace = sdd('workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node');
  assert.strictEqual(workspace.status, 0, workspace.stderr);
  const started = sdd('run', 'start', '--repo', repo, '--workspace', 'app', '--route', route,
    '--source', 'docs/need.md', ...extra);
  assert.strictEqual(started.status, 0, started.stderr);
  const id = started.stdout.match(/^run (\S+)/m)[1];
  return { repo, id, run: path.join(repo, '.sdd-dev', 'runs', id) };
}

function writeArtifacts(run, tasks = [
  { id: 'T-1', ac: 'AC-1', path: 'src/a.js' },
  { id: 'T-2', ac: 'AC-2', path: 'src/b.js' },
]) {
  const spec = fs.readFileSync(path.join(TOOL_ROOT, 'templates', 'run', 'execution-spec.md'), 'utf8')
    .replace('run_id: ""', `run_id: "${path.basename(run)}"`)
    .replace('<!-- sec:acceptance -->\n- id: AC-1\n  requirement: R-1\n  kind: normal\n  given: 前置成立\n  when: 執行該操作\n  then: 觀察到預期結果\n  pass: 結果與 then 一致\n  verify: ""',
      `<!-- sec:acceptance -->\n${tasks.map((task) => `- id: ${task.ac}\n  requirement: R-1\n  kind: normal\n  given: 前置成立\n  when: 執行該操作\n  then: 觀察到預期結果\n  pass: 結果與 then 一致\n  verify: manual`).join('\n')}`);
  fs.mkdirSync(path.join(run, 'spec', 'revisions'), { recursive: true });
  fs.writeFileSync(path.join(run, 'spec', 'execution-spec.md'), spec);
  fs.writeFileSync(path.join(run, 'spec', 'revisions', 'r1.md'), spec);
  const hash = revisionHash(Buffer.from(spec));
  const template = fs.readFileSync(path.join(TOOL_ROOT, 'templates', 'run', 'plan.md'), 'utf8');
  const plan = template.replace('run_id: ""', `run_id: "${path.basename(run)}"`)
    .replace('content_hash: ""', `content_hash: "${hash}"`)
    .replace(/<!-- sec:tasks -->[\s\S]*?<!-- sec:verification -->/,
      `<!-- sec:tasks -->\n${tasks.map((task) => `- id: ${task.id}\n  purpose: 工作\n  paths: ${task.path}\n  acceptance: ${task.ac}\n  status: pending`).join('\n')}\n\n<!-- sec:verification -->`)
    .replace(/<!-- sec:verification -->[\s\S]*?<!-- sec:notes -->/,
      `<!-- sec:verification -->\n${tasks.map((task) => `- id: ${task.ac}\n  method: manual`).join('\n')}\n\n<!-- sec:notes -->`);
  fs.mkdirSync(path.join(run, 'plan', 'revisions'), { recursive: true });
  fs.writeFileSync(path.join(run, 'plan', 'plan.md'), plan);
  fs.writeFileSync(path.join(run, 'plan', 'revisions', 'r1.md'), plan);
  return { spec, plan, hash };
}

function next(repo) {
  const result = sdd('run', 'next', '--repo', repo, '--json');
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function evidence(repo, run, ac) {
  const dir = path.join(run, 'evidence', ac);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.txt'), 'ok\n');
  writeJson(path.join(dir, 'meta.json'), {
    ac, status: 'pass', codebase_ref: computeCodebase(repo, '.').codebase_ref,
  });
}

module.exports = function lifecycleTests(test) {
  test('AC-2/3 next stays read-only and continues a sibling when T-1 is blocked', () => {
    const { repo, run } = createRun();
    writeArtifacts(run);
    const manifest = readJson(path.join(run, 'manifest.json'));
    manifest.implementation_authorized = true;
    manifest.blocks.push({ id: 'B-1', affected: ['T-1'], condition: 'need external input' });
    writeJson(path.join(run, 'manifest.json'), manifest);
    const before = fs.readFileSync(path.join(run, 'manifest.json'));
    const result = next(repo);
    assert.strictEqual(result.action, 'continue');
    assert(result.next_steps.some((item) => item.kind === 'task' && item.id === 'T-2'));
    assert(!result.next_steps.some((item) => item.kind === 'task' && item.id === 'T-1'));
    assert.deepStrictEqual(fs.readFileSync(path.join(run, 'manifest.json')), before);
    assert.strictEqual(fs.existsSync(path.join(run, 'report.md')), false);
  });

  test('AC-4/5/7 stop-after, stopped, and missing prepare cannot become done', () => {
    const stoppedAtSpec = createRun('direct', ['--stop-after', 'spec']);
    writeArtifacts(stoppedAtSpec.run);
    assert.strictEqual(next(stoppedAtSpec.repo).reason, 'stop_after_spec');
    assert.strictEqual(sdd('run', 'done', '--repo', stoppedAtSpec.repo).status, 1);
    const active = createRun();
    writeArtifacts(active.run);
    evidence(active.repo, active.run, 'AC-1');
    evidence(active.repo, active.run, 'AC-2');
    const checked = next(active.repo);
    assert.strictEqual(checked.acceptance_passed, true);
    assert.strictEqual(checked.can_complete, false);
    assert(checked.completion_issues.some((item) => item.kind === 'prepare'));
    assert.strictEqual(sdd('run', 'done', '--repo', active.repo).status, 1);
    const report = fs.readFileSync(path.join(active.run, 'report.md'), 'utf8');
    assert.match(report, /^# report\n\n## 需要你處理\n\n- 無/m);
    assert.match(report, /## 無法確認\n\n- 未記錄研究查核/);
    assert.doesNotMatch(report, /\n已完成\n/);
    const manifest = readJson(path.join(active.run, 'manifest.json'));
    manifest.status = 'stopped';
    writeJson(path.join(active.run, 'manifest.json'), manifest);
    assert.strictEqual(next(active.repo).reason, 'user_stopped');
  });

  test('AC-4/16 selected advisors avoid product tasks; malformed source fails next', () => {
    const advisors = createRun('selected_advisors');
    assert.strictEqual(next(advisors.repo).action, 'continue');
    const manifest = readJson(path.join(advisors.run, 'manifest.json'));
    manifest.sources[0].path = 7;
    writeJson(path.join(advisors.run, 'manifest.json'), manifest);
    const bad = sdd('run', 'next', '--repo', advisors.repo, '--json');
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /invalid source/);
    assert.doesNotMatch(bad.stderr, /TypeError|\sat\s.*\.js:/);
  });

  test('AC-4 plan_only waits at Plan, then resumes after its approval', () => {
    const opened = createRun('direct', ['--plan-only']);
    const artifacts = writeArtifacts(opened.run);
    const manifest = readJson(path.join(opened.run, 'manifest.json'));
    manifest.status = 'awaiting_user';
    writeJson(path.join(opened.run, 'manifest.json'), manifest);
    const waiting = next(opened.repo);
    assert.strictEqual(waiting.reason, 'plan_only');
    assert(waiting.user_actions.some((item) => item.id === 'plan'));
    writeJson(path.join(opened.run, 'approvals', 'plan.json'), {
      artifact: 'plan', revision: 1, content_hash: revisionHash(Buffer.from(artifacts.plan)),
      based_on_spec: { revision: 1, content_hash: artifacts.hash },
      approved_at: '2026-10-05T00:00:00.000Z', carried_from: null, auto_commit: false,
    });
    manifest.status = 'active';
    manifest.implementation_authorized = true;
    writeJson(path.join(opened.run, 'manifest.json'), manifest);
    const resumed = next(opened.repo);
    assert.strictEqual(resumed.action, 'continue');
    assert(resumed.next_steps.some((item) => item.kind === 'task'));
  });

  test('AC-4/16 awaiting_user needs a decision and invalid T stop cannot be guessed', () => {
    const opened = createRun();
    writeArtifacts(opened.run);
    const manifest = readJson(path.join(opened.run, 'manifest.json'));
    manifest.status = 'awaiting_user';
    manifest.implementation_authorized = true;
    writeJson(path.join(opened.run, 'manifest.json'), manifest);
    const waiting = next(opened.repo);
    assert.strictEqual(waiting.action, 'wait_user');
    assert(waiting.user_actions.some((item) => item.kind === 'decision'));
    manifest.stop_after = 'T-99';
    writeJson(path.join(opened.run, 'manifest.json'), manifest);
    const invalid = sdd('run', 'next', '--repo', opened.repo, '--json');
    assert.strictEqual(invalid.status, 1);
    assert.match(invalid.stderr, /stop_after T-99 is not in the current Plan/);
  });

  test('AC-1/10/14 direct prepare permits done and later drift leaves historical done intact', () => {
    const opened = createRun();
    writeArtifacts(opened.run);
    evidence(opened.repo, opened.run, 'AC-1');
    evidence(opened.repo, opened.run, 'AC-2');
    const input = path.join(opened.run, 'review-input.json');
    fs.writeFileSync(input, `${JSON.stringify({ read_scope: ['docs/need.md'], findings: [], unconfirmed: [] })}\n`);
    const prepared = sdd('review', 'prepare', '--repo', opened.repo, '--file', input);
    assert.strictEqual(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const ready = next(opened.repo);
    assert.strictEqual(ready.action, 'run_done');
    assert.strictEqual(ready.can_complete, true);
    const report = fs.readFileSync(path.join(opened.run, 'report.md'), 'utf8');
    assert.match(report, /\n可完成\n/);
    const finished = sdd('run', 'done', '--repo', opened.repo);
    assert.strictEqual(finished.status, 0, `${finished.stdout}${finished.stderr}`);
    assert.strictEqual(readJson(path.join(opened.run, 'manifest.json')).status, 'done');
    assert.match(fs.readFileSync(path.join(opened.run, 'report.md'), 'utf8'), /\n已完成\n/);
    fs.writeFileSync(path.join(opened.repo, 'docs', 'need.md'), 'changed\n');
    const drifted = next(opened.repo);
    assert.strictEqual(drifted.reason, 'done_drift');
    assert.strictEqual(drifted.can_complete, false);
    assert.strictEqual(readJson(path.join(opened.run, 'manifest.json')).status, 'done');
    assert.strictEqual(sdd('run', 'done', '--repo', opened.repo).status, 1);
  });
};
