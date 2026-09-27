'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson } = require('../lib/fsutil');
const { contentHash } = require('../lib/hash');
const { revisionHash } = require('../lib/revision');
const { PLAN_KEYS } = require('../lib/plan');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');

function sdd(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
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

const SPEC_KEYS = [
  'sources', 'clarifications', 'scope', 'exclusions', 'constraints',
  'interfaces', 'assumptions', 'deviations', 'requirements', 'acceptance',
];

function start(repo, route) {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
  const result = sdd([
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', route, '--source', 'docs/need.md',
  ]);
  assert.strictEqual(result.status, 0, output(result));
  const match = result.stdout.match(/^run (\S+)/m);
  assert(match, output(result));
  return { id: match[1], run: path.join(repo, '.sdd-dev', 'runs', match[1]) };
}

function renderSpec(revision, overrides = {}) {
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
    acceptance: [
      '- id: AC-1',
      '  requirement: R-1',
      '  kind: normal',
      '  given: a page',
      '  when: the user clicks',
      '  then: it opens',
      '  pass: the dialog is visible',
      '',
    ].join('\n'),
    ...overrides,
  };
  const body = SPEC_KEYS.map((key) => {
    const text = sections[key].endsWith('\n') ? sections[key] : `${sections[key]}\n`;
    return `<!-- sec:${key} -->\n${text}`;
  }).join('\n');
  return `---\nartifact: execution-spec\nrevision: ${revision}\nstatus: draft\n---\n\n${body}`;
}

function task(extra = {}) {
  const id = extra.id || 'T-1';
  const fields = {
    purpose: 'add the button',
    paths: 'src/a.ts',
    integrator: 'planner',
    depends: '',
    acceptance: 'AC-1',
    commit: 'button',
    preexisting_overlap: '',
    reason: '',
    status: 'pending',
  };
  for (const key of Object.keys(extra)) {
    if (key === 'id') continue;
    fields[key] = extra[key];
  }
  return [`- id: ${id}`, ...Object.keys(fields).map((key) => `  ${key}: ${fields[key]}`), ''].join('\n');
}

function renderPlan({
  revision = 1,
  specRevision = 1,
  specHash,
  scope = 'button\n',
  notes = '\n',
  status = 'pending',
  paths = 'src/a.ts',
  tasks = null,
}) {
  const sections = {
    goals: 'ship the button\n',
    scope,
    constraints: '\n',
    decisions: '\n',
    interfaces: '\n',
    paths: `${paths}\n`,
    dependencies: '\n',
    tasks: tasks || task({ status, paths }),
    verification: '- id: AC-1\n  method: npm test\n',
    notes,
  };
  const body = PLAN_KEYS.map((key) => {
    const text = sections[key].endsWith('\n') ? sections[key] : `${sections[key]}\n`;
    return `<!-- sec:${key} -->\n${text}`;
  }).join('\n');
  return [
    '---',
    'artifact: plan',
    `revision: ${revision}`,
    'status: draft',
    'based_on:',
    '  artifact: execution-spec',
    `  revision: ${specRevision}`,
    `  content_hash: ${specHash}`,
    '---',
    '',
    body,
  ].join('\n');
}

function writeFile(repo, name, text) {
  const file = path.join(repo, name);
  fs.writeFileSync(file, text);
  return file;
}

function putImpact(run, revision, items, dir) {
  const body = `${items.map((item) => `- section: ${item.section}\n  impact: ${item.impact}\n  reason: ${item.reason}\n`).join('\n')}\n`;
  const file = path.join(run, dir, 'impact', `r${revision}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

module.exports = function p11Tests(test) {
  test('AC-P11-1 spec approve records the revision hash and lets plan write proceed', () => {
    const repo = tmpRepo();
    install(repo);
    const { id, run } = start(repo, 'full_pipeline');
    const specFile = writeFile(repo, 'spec.md', renderSpec(1));
    const written = sdd(['spec', 'write', '--repo', repo, '--file', specFile]);
    assert.strictEqual(written.status, 0, output(written));
    const checked = sdd(['check', '--stage', 'spec', '--repo', repo]);
    assert.strictEqual(checked.status, 0, output(checked));
    const approved = sdd(['spec', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 0, output(approved));
    const frozen = fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md'));
    const doc = readJson(path.join(run, 'approvals', 'spec.json'));
    assert.strictEqual(doc.artifact, 'execution-spec');
    assert.strictEqual(doc.revision, 1);
    assert.strictEqual(doc.content_hash, revisionHash(frozen));
    assert.strictEqual(doc.carried_from, null);
    const planFile = writeFile(repo, 'plan.md', renderPlan({ specHash: doc.content_hash }));
    const plan = sdd(['plan', 'write', '--repo', repo, '--file', planFile]);
    assert.strictEqual(plan.status, 0, output(plan));
    assert.match(plan.stdout, new RegExp(`plan r1 ${id}`));
  });

  test('AC-P11-2 spec approve refuses a requirement that has no acceptance', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo, 'full_pipeline');
    const specFile = writeFile(repo, 'spec.md', renderSpec(1, { acceptance: '\n' }));
    const written = sdd(['spec', 'write', '--repo', repo, '--file', specFile]);
    assert.strictEqual(written.status, 0, output(written));
    const approved = sdd(['spec', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 1, output(approved));
    assert.match(output(approved), /R-1 has no acceptance/);
    assert.strictEqual(fs.existsSync(path.join(run, 'approvals', 'spec.json')), false);
  });

  test('AC-P11-3 revoking a carried plan approval blocks in_progress and lists the revocation', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo, 'full_pipeline');
    const specFile = writeFile(repo, 'spec.md', renderSpec(1));
    assert.strictEqual(sdd(['spec', 'write', '--repo', repo, '--file', specFile]).status, 0);
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
    assert.strictEqual(sdd(['spec', 'approve', '--repo', repo]).status, 0);
    const plan1 = writeFile(repo, 'plan.md', renderPlan({ specHash: hash, notes: 'v1\n' }));
    assert.strictEqual(sdd(['plan', 'write', '--repo', repo, '--file', plan1]).status, 0, output(sdd(['plan', 'write', '--repo', repo, '--file', plan1])));
    const reviewed = sdd([
      'review', 'write', '--repo', repo, '--kind', 'plan', '--verdict', 'READY', '--reviewer-kind', 'human',
    ]);
    assert.strictEqual(reviewed.status, 0, output(reviewed));
    assert.strictEqual(sdd(['plan', 'approve', '--repo', repo]).status, 0);
    const plan2 = writeFile(repo, 'plan.md', renderPlan({ revision: 2, specHash: hash, notes: 'v2\n' }));
    const wrote2 = sdd(['plan', 'write', '--repo', repo, '--file', plan2]);
    assert.strictEqual(wrote2.status, 0, output(wrote2));
    putImpact(run, 2, [{ section: 'notes', impact: 'none', reason: 'wording' }], 'plan');
    const carried = sdd(['plan', 'approve', '--repo', repo, '--carry-from', '1']);
    assert.strictEqual(carried.status, 0, output(carried));
    assert.strictEqual(readJson(path.join(run, 'approvals', 'plan.json')).carried_from.revision, 1);
    const revoked = sdd(['approval', 'revoke', '--repo', repo, '--artifact', 'plan', '--reason', 'scope changed']);
    assert.strictEqual(revoked.status, 0, output(revoked));
    assert.strictEqual(fs.existsSync(path.join(run, 'approvals', 'plan.json')), false);
    const moved = readJson(path.join(run, 'approvals', 'revoked', 'plan-r2.json'));
    assert.strictEqual(moved.reason, 'scope changed');
    assert.strictEqual(moved.carried_from.revision, 1);
    const report = fs.readFileSync(path.join(run, 'report.md'), 'utf8');
    assert.match(report, /## 沿用核准[\s\S]*已推翻 scope changed/);
    const current = fs.readFileSync(path.join(run, 'plan', 'plan.md'), 'utf8').replace('status: pending', 'status: in_progress');
    fs.writeFileSync(path.join(run, 'plan', 'plan.md'), current);
    const checked = sdd(['check', '--stage', 'plan', '--repo', repo]);
    assert.strictEqual(checked.status, 1, output(checked));
    assert.match(output(checked), /cannot be in_progress without a plan approval/);
  });

  test('AC-P11-4 review carry fails when plan scope changed', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo, 'full_pipeline');
    const specFile = writeFile(repo, 'spec.md', renderSpec(1));
    assert.strictEqual(sdd(['spec', 'write', '--repo', repo, '--file', specFile]).status, 0);
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
    assert.strictEqual(sdd(['spec', 'approve', '--repo', repo]).status, 0);
    const plan1 = writeFile(repo, 'plan.md', renderPlan({ specHash: hash, scope: 'button\n' }));
    assert.strictEqual(sdd(['plan', 'write', '--repo', repo, '--file', plan1]).status, 0, output(sdd(['plan', 'write', '--repo', repo, '--file', plan1])));
    const reviewed = sdd([
      'review', 'write', '--repo', repo, '--kind', 'plan', '--verdict', 'READY', '--reviewer-kind', 'human',
    ]);
    assert.strictEqual(reviewed.status, 0, output(reviewed));
    const plan2 = writeFile(repo, 'plan.md', renderPlan({ revision: 2, specHash: hash, scope: 'button and menu\n' }));
    const wrote2 = sdd(['plan', 'write', '--repo', repo, '--file', plan2]);
    assert.strictEqual(wrote2.status, 0, output(wrote2));
    putImpact(run, 2, [{ section: 'scope', impact: 'none', reason: 'wording' }], 'plan');
    const carried = sdd(['review', 'carry', '--repo', repo, '--kind', 'plan', '--from', '1']);
    assert.strictEqual(carried.status, 1, output(carried));
    assert.match(output(carried), /cannot carry scope/);
    assert.strictEqual(fs.existsSync(path.join(run, 'review', 'plan-review-r2.md')), false);
    fs.mkdirSync(path.join(run, 'review'), { recursive: true });
    fs.writeFileSync(path.join(run, 'review', 'plan-review-r2.md'), [
      '---',
      'artifact: plan-review',
      'revision: 2',
      'verdict: READY',
      'reviewer_kind: human',
      'carried_from:',
      '  revision: 1',
      '  impact: plan/impact/r2.md',
      '---',
      '',
    ].join('\n'));
    const approved = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 1, output(approved));
    assert.match(output(approved), /READY plan review/);
    assert.strictEqual(fs.existsSync(path.join(run, 'approvals', 'plan.json')), false);
  });

  test('AC-P11-5 upgrading direct to full_pipeline drops implementation authority until plan approval', () => {
    const repo = tmpRepo();
    install(repo);
    const { id, run } = start(repo, 'direct');
    const specFile = writeFile(repo, 'spec.md', renderSpec(1));
    assert.strictEqual(sdd(['spec', 'write', '--repo', repo, '--file', specFile]).status, 0);
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
    const planFile = writeFile(repo, 'plan.md', renderPlan({ specHash: hash }));
    const wrote = sdd(['plan', 'write', '--repo', repo, '--file', planFile]);
    assert.strictEqual(wrote.status, 0, output(wrote));
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).implementation_authorized, true);
    const upgraded = sdd([
      'run', 'route', '--repo', repo, '--route', 'full_pipeline',
      '--reason', 'needs a review', '--by', 'user',
    ]);
    assert.strictEqual(upgraded.status, 0, output(upgraded));
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).implementation_authorized, false);
    assert.strictEqual(sdd(['spec', 'approve', '--repo', repo]).status, 0);
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).implementation_authorized, false);
    const reviewed = sdd([
      'review', 'write', '--repo', repo, '--kind', 'plan', '--verdict', 'READY', '--reviewer-kind', 'human',
    ]);
    assert.strictEqual(reviewed.status, 0, output(reviewed));
    const approved = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 0, output(approved));
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).implementation_authorized, true);
    assert.match(approved.stdout, new RegExp(id));
  });

  test('AC-P11-6 a new plan revision refreshes write_roots and stales the executor context', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo, 'direct');
    const specFile = writeFile(repo, 'spec.md', renderSpec(1));
    assert.strictEqual(sdd(['spec', 'write', '--repo', repo, '--file', specFile]).status, 0);
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
    const planFile = writeFile(repo, 'plan.md', renderPlan({ specHash: hash, paths: 'src/a.ts' }));
    assert.strictEqual(sdd(['plan', 'write', '--repo', repo, '--file', planFile]).status, 0);
    const before = readJson(path.join(run, 'manifest.json'));
    assert.ok(before.write_roots.includes('src/a.ts'));
    const listed = sdd(['context', '--repo', repo, '--role', 'executor', '--task', 'T-1']);
    assert.strictEqual(listed.status, 0, output(listed));
    const contextPath = path.join(run, 'context', 'executor-T-1.json');
    assert.strictEqual(readJson(contextPath).stale, false);
    const plan2 = writeFile(repo, 'plan.md', renderPlan({ revision: 2, specHash: hash, paths: 'src/b.ts' }));
    const wrote = sdd(['plan', 'write', '--repo', repo, '--file', plan2]);
    assert.strictEqual(wrote.status, 0, output(wrote));
    const checked = sdd(['check', '--repo', repo]);
    assert.strictEqual(checked.status, 0, output(checked));
    const after = readJson(path.join(run, 'manifest.json'));
    assert.ok(after.write_roots.includes('src/b.ts'));
    assert.ok(!after.write_roots.includes('src/a.ts'));
    assert.strictEqual(readJson(contextPath).stale, true);
    assert.match(checked.stdout, /stale context executor-T-1/);
  });

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

    const gated = tmpRepo();
    install(gated);
    const opened = start(gated, 'full_pipeline');
    const specFile = writeFile(gated, 'spec.md', renderSpec(1));
    assert.strictEqual(sdd(['spec', 'write', '--repo', gated, '--file', specFile]).status, 0);
    assert.strictEqual(sdd(['spec', 'approve', '--repo', gated]).status, 0);
    const hash = revisionHash(fs.readFileSync(path.join(opened.run, 'spec', 'revisions', 'r1.md')));
    const planFile = writeFile(gated, 'plan.md', renderPlan({ specHash: hash, paths: 'src/a.ts' }));
    assert.strictEqual(sdd(['plan', 'write', '--repo', gated, '--file', planFile]).status, 0);
    assert.strictEqual(readJson(path.join(opened.run, 'manifest.json')).implementation_authorized, false);
    fs.unlinkSync(specFile);
    fs.unlinkSync(planFile);
    fs.mkdirSync(path.join(gated, 'src'), { recursive: true });
    fs.writeFileSync(path.join(gated, 'src', 'a.ts'), 'export const gated = 1;\n');
    const blocked = sdd(['check', '--stage', 'dev', '--repo', gated]);
    assert.strictEqual(blocked.status, 1, output(blocked));
    assert.match(blocked.stderr, /越界 src\/a\.ts/);
    assert.match(blocked.stdout, /route_reassess src\/a\.ts/);
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

  test('AC-P11-9 blocking one independent task stays active until every remaining task is blocked', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo, 'direct');
    const specFile = writeFile(repo, 'spec.md', renderSpec(1));
    assert.strictEqual(sdd(['spec', 'write', '--repo', repo, '--file', specFile]).status, 0);
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
    const tasks = [
      task({ id: 'T-1', paths: 'src/a.ts', commit: 'button' }),
      task({ id: 'T-2', paths: 'src/b.ts', commit: 'menu', purpose: 'add the menu' }),
    ].join('\n');
    const planFile = writeFile(repo, 'plan.md', renderPlan({ specHash: hash, paths: 'src/a.ts, src/b.ts', tasks }));
    assert.strictEqual(sdd(['plan', 'write', '--repo', repo, '--file', planFile]).status, 0);
    const first = sdd([
      'block', 'add', '--repo', repo, '--id', 'B-1', '--affects', 'T-1', '--condition', 'waiting on T-1',
    ]);
    assert.strictEqual(first.status, 0, output(first));
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).status, 'active');
    const second = sdd([
      'block', 'add', '--repo', repo, '--id', 'B-2', '--affects', 'T-2', '--condition', 'waiting on T-2',
    ]);
    assert.strictEqual(second.status, 0, output(second));
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).status, 'blocked');
  });

  test('AC-P11-10 resolving a downstream problem without evidence exits 3 and keeps the block', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo, 'direct');
    const added = sdd([
      'problem', 'add', '--repo', repo,
      '--impact', 'stops T-1', '--handling', 'wait', '--reason', 'missing input',
      '--blocks-downstream', '--affects', 'T-1',
    ]);
    assert.strictEqual(added.status, 0, output(added));
    const resolved = sdd(['problem', 'resolve', 'P-1', '--repo', repo, '--result', 'TODO']);
    assert.strictEqual(resolved.status, 3, output(resolved));
    const manifest = readJson(path.join(run, 'manifest.json'));
    const block = manifest.blocks.find((item) => item.id === 'problem:P-1');
    assert.ok(block);
    assert.strictEqual(block.evidence, undefined);
    assert.strictEqual(block.resolved_at, undefined);
    const text = fs.readFileSync(path.join(run, 'problems.md'), 'utf8');
    assert.match(text, /## P-1/);
    assert.match(text, /- result:\s*$/m);
    fs.writeFileSync(path.join(run, 'problems.md'), text.replace('- result:', '- result: TODO'));
    const checked = sdd(['check', '--repo', repo]);
    assert.strictEqual(checked.status, 1, output(checked));
    assert.match(output(checked), /P-1 blocks downstream without evidence/);
    fs.writeFileSync(path.join(run, 'evidence.txt'), 'done\n');
    const fixed = sdd([
      'problem', 'resolve', 'P-1', '--repo', repo, '--result', 'done', '--evidence', 'evidence.txt',
    ]);
    assert.strictEqual(fixed.status, 0, output(fixed));
    const cleared = readJson(path.join(run, 'manifest.json')).blocks.find((item) => item.id === 'problem:P-1');
    assert.strictEqual(cleared.evidence, 'evidence.txt');
    assert.ok(cleared.resolved_at);
    const again = sdd(['check', '--repo', repo]);
    assert.strictEqual(again.status, 0, output(again));
  });

  test('AC-P11-11 a stopped run cannot be marked done', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo, 'direct');
    const stopped = sdd(['run', 'stop', '--repo', repo, '--reason', 'user halted']);
    assert.strictEqual(stopped.status, 0, output(stopped));
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).status, 'stopped');
    const done = sdd(['run', 'done', '--repo', repo]);
    assert.strictEqual(done.status, 1, output(done));
    assert.match(done.stderr, /is stopped/);
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).status, 'stopped');
  });

  test('AC-P11-12 adding the same block twice counts as one', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = start(repo, 'direct');
    const args = ['block', 'add', '--repo', repo, '--id', 'B-1', '--affects', 'T-1', '--condition', 'waiting'];
    const first = sdd(args);
    assert.strictEqual(first.status, 0, output(first));
    const again = sdd(args);
    assert.strictEqual(again.status, 0, output(again));
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).blocks.length, 1);
    const metrics = sdd(['metrics', '--repo', repo]);
    assert.strictEqual(metrics.status, 0, output(metrics));
    assert.strictEqual(readJson(path.join(run, 'metrics.json')).blocks, 1);
  });

  test('AC-P11-22 run start without a platform records every cell as an unmeasured gap', () => {
    const { CELLS } = require('../lib/capabilities');
    const repo = tmpRepo();
    install(repo);
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
    const env = { ...process.env };
    delete env.SDD_PLATFORM;
    const result = sdd([
      'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md',
    ], { env });
    assert.strictEqual(result.status, 0, output(result));
    const id = result.stdout.match(/^run (\S+)/m)[1];
    const manifest = readJson(path.join(repo, '.sdd-dev', 'runs', id, 'manifest.json'));
    assert.strictEqual(manifest.platform, 'unknown');
    assert.deepStrictEqual(manifest.capability_limits.map((item) => item.op), CELLS.map((item) => item[0]));
    assert.ok(manifest.capability_limits.every((item) => item.layer === 'convention' && item.measured === false));
    assert.strictEqual(manifest.capability_limits.some((item) => item.op === 'direct'), false);
    assert.strictEqual(manifest.capability_limits.some((item) => item.op === 'full_pipeline'), false);
    assert.strictEqual(manifest.capability_limits.some((item) => item.op === 'selected_advisors'), false);
  });

  test('AC-P11-23 an unmeasured cursor block_git_commit is a convention gap and blocks when required', () => {
    const repo = tmpRepo();
    install(repo);
    const policy = readJson(path.join(repo, '.sdd-dev', 'config', 'policy.json'));
    policy.required_enforcement = ['block_git_commit'];
    writeJson(path.join(repo, '.sdd-dev', 'config', 'policy.json'), policy);
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
    const env = { ...process.env };
    delete env.SDD_PLATFORM;
    const result = sdd([
      'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md',
      '--platform', 'cursor',
    ], { env });
    assert.strictEqual(result.status, 0, output(result));
    const id = result.stdout.match(/^run (\S+)/m)[1];
    const manifest = readJson(path.join(repo, '.sdd-dev', 'runs', id, 'manifest.json'));
    const gap = manifest.capability_limits.find((item) => item.op === 'block_git_commit');
    assert.ok(gap);
    assert.strictEqual(gap.layer, 'convention');
    assert.strictEqual(gap.measured, false);
    assert.strictEqual(manifest.status, 'blocked');
    assert.ok(manifest.blocks.some((item) => item.id === 'capability:block_git_commit'));
    assert.strictEqual(manifest.capability_limits.some((item) => item.op === 'delegate'), false);
  });
};