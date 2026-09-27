'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson } = require('../lib/fsutil');
const { revisionHash } = require('../lib/revision');
const { PLAN_KEYS, readPlanApproval } = require('../lib/plan');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');
const SPEC_KEYS = [
  'sources',
  'clarifications',
  'scope',
  'exclusions',
  'constraints',
  'interfaces',
  'assumptions',
  'deviations',
  'requirements',
  'acceptance',
];

function sdd(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p5-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function install(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

function start(repo, route = 'direct') {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
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

function task(id, extra = {}) {
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
    ...extra,
  };
  return [`- id: ${id}`, ...Object.keys(fields).map((key) => `  ${key}: ${fields[key]}`), ''].join('\n');
}

function renderPlan({ revision = 1, specRevision = 1, specHash, tasks, overrides = {}, omit = [] }) {
  const sections = {
    goals: 'ship the button\n',
    scope: 'button\n',
    constraints: '\n',
    decisions: '\n',
    interfaces: '\n',
    paths: 'src/a.ts\n',
    dependencies: '\n',
    tasks: tasks || task('T-1'),
    verification: '- id: AC-1\n  method: npm test\n',
    notes: '\n',
    ...overrides,
  };
  const body = PLAN_KEYS
    .filter((key) => !omit.includes(key))
    .map((key) => {
      const text = sections[key].endsWith('\n') ? sections[key] : `${sections[key]}\n`;
      return `<!-- sec:${key} -->\n${text}`;
    })
    .join('\n');
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

function putSpec(run, revision, text) {
  const file = path.join(run, 'spec', 'revisions', `r${revision}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(run, 'spec', 'execution-spec.md'), text);
}

function putPlan(run, revision, text) {
  const file = path.join(run, 'plan', 'revisions', `r${revision}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  fs.writeFileSync(path.join(run, 'plan', 'plan.md'), text.endsWith('\n') ? text : `${text}\n`);
}

function putImpact(run, revision, items) {
  const body = `${items.map((item) => `- section: ${item.section}\n  impact: ${item.impact}\n  reason: ${item.reason}\n`).join('\n')}\n`;
  const file = path.join(run, 'spec', 'impact', `r${revision}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function approveSpec(run, revision, carriedFrom) {
  const file = path.join(run, 'spec', 'revisions', `r${revision}.md`);
  writeJson(path.join(run, 'approvals', 'spec.json'), {
    artifact: 'execution-spec',
    revision,
    content_hash: revisionHash(fs.readFileSync(file)),
    approved_at: '2026-09-26T00:00:00.000Z',
    carried_from: carriedFrom,
  });
}

function checkedDimensions() {
  return ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'].map((id) => `- id: ${id}\n  status: checked`).join('\n');
}

function putReview(run, revision, verdict = 'READY', extra = {}) {
  const lines = [
    '---',
    'artifact: plan-review',
    `revision: ${revision}`,
    `verdict: ${verdict}`,
    `reviewer_kind: ${extra.reviewer_kind || 'human'}`,
  ];
  if (extra.independent !== undefined) lines.push(`independent: ${extra.independent}`);
  if (extra.context_id) lines.push(`context_id: ${extra.context_id}`);
  lines.push('---', '');
  lines.push(checkedDimensions(), '');
  if (extra.findings) lines.push(extra.findings.endsWith('\n') ? extra.findings : `${extra.findings}\n`);
  const file = path.join(run, 'review', `plan-review-r${revision}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
}

function finding(fields) {
  const id = fields.id || 'F-1';
  return [`- id: ${id}`, ...Object.keys(fields).filter((key) => key !== 'id').map((key) => `  ${key}: ${fields[key]}`), ''].join('\n');
}

function patchManifest(run, fn) {
  const file = path.join(run, 'manifest.json');
  const doc = readJson(file);
  fn(doc);
  writeJson(file, doc);
  return doc;
}

function prepare(route = 'direct') {
  const repo = tmpRepo();
  install(repo);
  const id = start(repo, route);
  const run = runPath(repo, id);
  const file = path.join(repo, 'spec.md');
  fs.writeFileSync(file, renderSpec(1));
  const written = sdd(['spec', 'write', '--repo', repo, '--file', file]);
  assert.strictEqual(written.status, 0, output(written));
  const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
  return { repo, id, run, hash };
}

function writePlanFile(repo, text) {
  const file = path.join(repo, 'plan.md');
  fs.writeFileSync(file, text);
  return sdd(['plan', 'write', '--repo', repo, '--file', file]);
}

function checkPlan(repo) {
  return sdd(['check', '--stage', 'plan', '--repo', repo]);
}

module.exports = function p5Tests(test) {
  test('plan template has the section markers and init writes policy.json', () => {
    const template = fs.readFileSync(path.join(TOOL_ROOT, 'templates', 'run', 'plan.md'), 'utf8');
    let at = -1;
    for (const key of PLAN_KEYS) {
      const next = template.indexOf(`<!-- sec:${key} -->`);
      assert(next > at, key);
      at = next;
    }
    const repo = tmpRepo();
    install(repo);
    const policy = readJson(path.join(repo, '.sdd-dev', 'config', 'policy.json'));
    assert.strictEqual(policy.version, '1');
    assert.strictEqual(policy.max_revise_rounds, 2);
    assert.deepStrictEqual(policy.required_enforcement, []);
    const id = start(repo);
    const manifest = readJson(path.join(runPath(repo, id), 'manifest.json'));
    assert.strictEqual(manifest.policy_version, '1');
    assert.deepStrictEqual(manifest.modifiers, {
      fast_lane: false,
      cross_check: false,
      no_delegation: false,
      plan_only: false,
    });
  });

  test('run start stores the four modifier flags on the manifest and the first route entry', () => {
    const repo = tmpRepo();
    install(repo);
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
    const opened = sdd([
      'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md',
      '--fast-lane', '--cross-check', '--no-delegation', '--plan-only',
    ]);
    assert.strictEqual(opened.status, 0, output(opened));
    const match = opened.stdout.match(/^run (\S+)/m);
    const manifest = readJson(path.join(runPath(repo, match[1]), 'manifest.json'));
    const expected = { fast_lane: true, cross_check: true, no_delegation: true, plan_only: true };
    assert.deepStrictEqual(manifest.modifiers, expected);
    assert.strictEqual(manifest.route_history.length, 1);
    assert.deepStrictEqual(manifest.route_history[0].modifiers, expected);
    assert.notStrictEqual(manifest.route_history[0].modifiers, manifest.modifiers);
  });

  test('run route records a real route change with reason and by', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo, 'direct');
    const run = runPath(repo, id);
    const before = readJson(path.join(run, 'manifest.json'));
    assert.strictEqual(before.route, 'direct');
    assert.strictEqual(before.implementation_authorized, false);
    const changed = sdd([
      'run', 'route', '--repo', repo, '--route', 'full_pipeline',
      '--reason', 'external interface', '--by', 'user', '--risk', 'external_interface',
    ]);
    assert.strictEqual(changed.status, 0, output(changed));
    const after = readJson(path.join(run, 'manifest.json'));
    assert.strictEqual(after.route, 'full_pipeline');
    assert.strictEqual(after.implementation_authorized, false);
    assert.strictEqual(after.route_history.length, 2);
    assert.strictEqual(after.route_history[0].route, 'direct');
    const entry = after.route_history[1];
    assert.strictEqual(entry.route, 'full_pipeline');
    assert.strictEqual(entry.reason, 'external interface');
    assert.strictEqual(entry.by, 'user');
    assert.deepStrictEqual(entry.risk_features, ['external_interface']);
    assert.notStrictEqual(entry.route, after.route_history[0].route);
    const same = sdd([
      'run', 'route', '--repo', repo, '--route', 'full_pipeline',
      '--reason', 'again', '--by', 'auto',
    ]);
    assert.strictEqual(same.status, 1, output(same));
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).route_history.length, 2);
  });

  test('full_pipeline plan write requires a valid spec approval for the current revision', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    const plan = renderPlan({ specHash: hash });
    const missing = writePlanFile(repo, plan);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /valid spec approval for the current revision/);
    assert.strictEqual(fs.existsSync(path.join(run, 'plan', 'plan.md')), false);

    patchManifest(run, (doc) => { doc.modifiers.fast_lane = true; });
    const fast = writePlanFile(repo, plan);
    assert.strictEqual(fast.status, 1, output(fast));
    assert.match(output(fast), /valid spec approval/);

    approveSpec(run, 1, null);
    const written = writePlanFile(repo, plan);
    assert.strictEqual(written.status, 0, output(written));
    assert.strictEqual(fs.readFileSync(path.join(run, 'plan', 'plan.md'), 'utf8'), plan.endsWith('\n') ? plan : `${plan}\n`);
  });

  test('a carried spec approval lets full_pipeline plan write proceed', () => {
    const { repo, run } = prepare('full_pipeline');
    const r2 = renderSpec(2, { sources: 'docs/need.md r2\n' });
    const file = path.join(repo, 'spec-r2.md');
    fs.writeFileSync(file, r2);
    const written = sdd(['spec', 'write', '--repo', repo, '--file', file]);
    assert.strictEqual(written.status, 0, output(written));
    putImpact(run, 2, [{ section: 'sources', impact: 'none', reason: 'source id refresh' }]);
    approveSpec(run, 2, { revision: 1, impact: 'spec/impact/r2.md' });
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r2.md')));
    const result = writePlanFile(repo, renderPlan({ specRevision: 2, specHash: hash }));
    assert.strictEqual(result.status, 0, output(result));
  });

  test('direct plan write does not require a spec approval', () => {
    const { repo, id, hash } = prepare('direct');
    const written = writePlanFile(repo, renderPlan({ specHash: hash }));
    assert.strictEqual(written.status, 0, output(written));
    assert.match(written.stdout, new RegExp(`plan r1 ${id}`));
  });

  test('AC-P5-1 overlapping task paths fail without a dependency and pass with one', () => {
    const { repo, run, hash } = prepare();
    putPlan(run, 1, renderPlan({ specHash: hash, tasks: task('T-1') + task('T-2') }));
    const overlap = checkPlan(repo);
    assert.strictEqual(overlap.status, 1, output(overlap));
    assert.match(output(overlap), /T-1 and T-2 paths overlap without a dependency/);

    putPlan(run, 1, renderPlan({ specHash: hash, tasks: task('T-1') + task('T-2', { paths: 'src/b.ts' }) }));
    const apart = checkPlan(repo);
    assert.strictEqual(apart.status, 0, output(apart));

    putPlan(run, 1, renderPlan({ specHash: hash, tasks: task('T-1') + task('T-2', { depends: 'T-1' }) }));
    const ordered = checkPlan(repo);
    assert.strictEqual(ordered.status, 0, output(ordered));

    const chain = task('T-1') + task('T-2', { paths: 'src/b.ts', depends: 'T-1' }) + task('T-3', { depends: 'T-2' });
    putPlan(run, 1, renderPlan({ specHash: hash, tasks: chain }));
    const transitive = checkPlan(repo);
    assert.strictEqual(transitive.status, 0, output(transitive));
  });

  test('a directory path overlaps a file underneath it', () => {
    const { repo, run, hash } = prepare();
    putPlan(run, 1, renderPlan({
      specHash: hash,
      tasks: task('T-1', { paths: 'src' }) + task('T-2', { paths: 'src/a.ts' }),
    }));
    const result = checkPlan(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /T-1 and T-2 paths overlap without a dependency/);
  });

  test('AC-P5-12 check --stage plan fails when a requirement has no task', () => {
    const { repo, run } = prepare();
    const spec = renderSpec(1, {
      requirements: '- id: R-1\n  text: one\n- id: R-2\n  text: two\n',
      acceptance: [
        '- id: AC-1',
        '  requirement: R-1',
        '  kind: normal',
        '  given: a page',
        '  when: the user clicks',
        '  then: it opens',
        '  pass: the dialog is visible',
        '- id: AC-2',
        '  requirement: R-2',
        '  kind: normal',
        '  given: a page',
        '  when: the user cancels',
        '  then: it stays',
        '  pass: no dialog',
        '',
      ].join('\n'),
    });
    putSpec(run, 1, spec);
    const hash = revisionHash(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md')));
    putPlan(run, 1, renderPlan({ specHash: hash }));
    const result = checkPlan(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /R-2 has no task/);
  });

  test('AC-P5-10 check --stage plan fails when based_on is not the current spec', () => {
    const { repo, run, hash } = prepare();
    const file = path.join(repo, 'spec-r2.md');
    fs.writeFileSync(file, renderSpec(2, { sources: 'docs/need.md r2\n' }));
    const written = sdd(['spec', 'write', '--repo', repo, '--file', file]);
    assert.strictEqual(written.status, 0, output(written));
    putPlan(run, 1, renderPlan({ specRevision: 1, specHash: hash }));
    const stale = checkPlan(repo);
    assert.strictEqual(stale.status, 1, output(stale));
    assert.match(output(stale), /based_on revision 1 is not current spec revision 2/);
    assert.match(output(stale), /new plan revision/);

    const current = revisionHash(fs.readFileSync(path.join(run, 'spec', 'execution-spec.md')));
    putPlan(run, 1, renderPlan({ specRevision: 2, specHash: 'sha256:not-the-spec' }));
    const mismatch = checkPlan(repo);
    assert.strictEqual(mismatch.status, 1, output(mismatch));
    assert.match(output(mismatch), /based_on does not match current spec revision 2/);
    assert.notStrictEqual('sha256:not-the-spec', current);
  });

  test('AC-P5-13 check --stage plan fails when a task path hits baseline dirty without preexisting_overlap', () => {
    const { repo, run, hash } = prepare();
    patchManifest(run, (doc) => { doc.workspaces[0].baseline.dirty = ['src/a.ts']; });
    putPlan(run, 1, renderPlan({ specHash: hash }));
    const missing = checkPlan(repo);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /T-1 intersects baseline dirty paths without preexisting_overlap/);

    putPlan(run, 1, renderPlan({ specHash: hash, tasks: task('T-1', { preexisting_overlap: 'separable' }) }));
    const filled = checkPlan(repo);
    assert.strictEqual(filled.status, 0, output(filled));
  });

  test('check --stage plan fails when a required section marker is missing', () => {
    const { repo, run, hash } = prepare();
    putPlan(run, 1, renderPlan({ specHash: hash, omit: ['constraints'] }));
    const result = checkPlan(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /missing section constraints/);
  });

  test('AC-P5-6 a plan approval without auto_commit reads as false', () => {
    const { repo, run, hash } = prepare();
    const written = writePlanFile(repo, renderPlan({ specHash: hash }));
    assert.strictEqual(written.status, 0, output(written));
    const approved = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 0, output(approved));
    const approvalPath = path.join(run, 'approvals', 'plan.json');
    const doc = readJson(approvalPath);
    assert.strictEqual(doc.auto_commit, false);
    assert.deepStrictEqual(doc.based_on_spec, { revision: 1, content_hash: hash });
    assert.strictEqual(doc.carried_from, null);
    delete doc.auto_commit;
    writeJson(approvalPath, doc);
    const bytes = fs.readFileSync(approvalPath);
    assert.strictEqual(readPlanApproval(run).auto_commit, false);
    const checked = checkPlan(repo);
    assert.strictEqual(checked.status, 0, output(checked));
    assert.deepStrictEqual(fs.readFileSync(approvalPath), bytes);

    const flagged = sdd(['plan', 'approve', '--repo', repo, '--auto-commit']);
    assert.strictEqual(flagged.status, 0, output(flagged));
    assert.strictEqual(readJson(approvalPath).auto_commit, true);
  });

  test('AC-P5-9 plan_only stops after the plan is written on direct and after a READY review on full_pipeline', () => {
    const direct = prepare('direct');
    patchManifest(direct.run, (doc) => { doc.modifiers.plan_only = true; });
    const wrote = writePlanFile(direct.repo, renderPlan({ specHash: direct.hash }));
    assert.strictEqual(wrote.status, 0, output(wrote));
    assert.match(wrote.stdout, new RegExp(`status awaiting_user ${direct.id}`));
    assert.strictEqual(readJson(path.join(direct.run, 'manifest.json')).status, 'awaiting_user');
    const planText = fs.readFileSync(path.join(direct.run, 'plan', 'plan.md'), 'utf8');
    assert.match(planText, /status: pending/);
    assert.doesNotMatch(planText, /in_progress/);
    const approved = sdd(['plan', 'approve', '--repo', direct.repo]);
    assert.strictEqual(approved.status, 0, output(approved));
    assert.match(approved.stdout, new RegExp(`status active ${direct.id}`));
    assert.strictEqual(readJson(path.join(direct.run, 'manifest.json')).status, 'active');

    const full = prepare('full_pipeline');
    approveSpec(full.run, 1, null);
    patchManifest(full.run, (doc) => { doc.modifiers.plan_only = true; });
    const fullWrite = writePlanFile(full.repo, renderPlan({ specHash: full.hash }));
    assert.strictEqual(fullWrite.status, 0, output(fullWrite));
    assert.strictEqual(readJson(path.join(full.run, 'manifest.json')).status, 'active');
    assert.doesNotMatch(fullWrite.stdout, /awaiting_user/);
    putReview(full.run, 1);
    const reviewed = checkPlan(full.repo);
    assert.strictEqual(reviewed.status, 0, output(reviewed));
    assert.match(reviewed.stdout, new RegExp(`status awaiting_user ${full.id}`));
    assert.strictEqual(readJson(path.join(full.run, 'manifest.json')).status, 'awaiting_user');
    assert.doesNotMatch(fs.readFileSync(path.join(full.run, 'plan', 'plan.md'), 'utf8'), /in_progress/);
    const fullApprove = sdd(['plan', 'approve', '--repo', full.repo]);
    assert.strictEqual(fullApprove.status, 0, output(fullApprove));
    assert.strictEqual(readJson(path.join(full.run, 'manifest.json')).status, 'active');
    const again = checkPlan(full.repo);
    assert.strictEqual(again.status, 0, output(again));
    assert.doesNotMatch(again.stdout, /awaiting_user/);
    assert.strictEqual(readJson(path.join(full.run, 'manifest.json')).status, 'active');
  });

  test('full_pipeline plan approve requires a READY review and does not write the approval early', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    approveSpec(run, 1, null);
    const written = writePlanFile(repo, renderPlan({ specHash: hash }));
    assert.strictEqual(written.status, 0, output(written));
    const early = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(early.status, 1, output(early));
    assert.match(output(early), /READY plan review/);
    assert.strictEqual(fs.existsSync(path.join(run, 'approvals', 'plan.json')), false);
    putReview(run, 1, 'REVISE');
    const revise = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(revise.status, 1, output(revise));
    putReview(run, 1, 'READY');
    const approved = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 0, output(approved));
    assert.strictEqual(readJson(path.join(run, 'approvals', 'plan.json')).auto_commit, false);
  });

  test('plan_only check fails while a task is in_progress and the run stays active', () => {
    const { repo, run, hash } = prepare();
    patchManifest(run, (doc) => { doc.modifiers.plan_only = true; });
    putPlan(run, 1, renderPlan({ specHash: hash, tasks: task('T-1', { status: 'in_progress' }) }));
    const result = checkPlan(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /T-1 is in_progress/);
    assert.strictEqual(readJson(path.join(run, 'manifest.json')).status, 'active');
  });

  test('AC-P5-2 plan approve fails while a blocking safety finding is unresolved', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    approveSpec(run, 1, null);
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash })).status, 0);
    putReview(run, 1, 'READY', {
      findings: finding({
        id: 'F-1',
        basis: 'D7',
        location: 'tasks',
        severity: 'high',
        suggestion: 'reject raw input',
        resolution: 'add a check',
        blocking: 'true',
      }),
    });
    const blocked = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(blocked.status, 1, output(blocked));
    assert.match(output(blocked), /unresolved blocking F-1 safety \(D7\)/);
    assert.strictEqual(fs.existsSync(path.join(run, 'approvals', 'plan.json')), false);

    putReview(run, 1, 'READY', {
      findings: finding({
        id: 'F-1',
        basis: 'D7',
        location: 'tasks',
        severity: 'high',
        suggestion: 'reject raw input',
        resolution: 'add a check',
        blocking: 'true',
        resolved: 'true',
      }),
    });
    const approved = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 0, output(approved));
  });

  test('AC-P5-3 no_delegation rejects an agent review marked independent', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    approveSpec(run, 1, null);
    patchManifest(run, (doc) => { doc.modifiers.no_delegation = true; });
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash })).status, 0);
    putReview(run, 1, 'READY', { reviewer_kind: 'agent', independent: 'true', context_id: 'reviewer-1' });
    const checked = checkPlan(repo);
    assert.strictEqual(checked.status, 1, output(checked));
    assert.match(output(checked), /reviewer_kind agent cannot be independent under no_delegation/);
    const approved = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 1, output(approved));
    assert.match(output(approved), /cannot be independent under no_delegation/);
    assert.strictEqual(fs.existsSync(path.join(run, 'approvals', 'plan.json')), false);
  });

  test('AC-P5-7 no_delegation accepts a human READY review', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    approveSpec(run, 1, null);
    patchManifest(run, (doc) => { doc.modifiers.no_delegation = true; });
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash })).status, 0);
    putReview(run, 1, 'READY', { reviewer_kind: 'human', independent: 'false' });
    const checked = checkPlan(repo);
    assert.strictEqual(checked.status, 0, output(checked));
    const approved = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 0, output(approved));
    assert.strictEqual(readJson(path.join(run, 'approvals', 'plan.json')).auto_commit, false);
  });

  test('an agent review with its own context_id can approve when delegation is allowed', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    approveSpec(run, 1, null);
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash })).status, 0);
    putReview(run, 1, 'READY', { reviewer_kind: 'agent', independent: 'true', context_id: 'reviewer-1' });
    const approved = sdd(['plan', 'approve', '--repo', repo]);
    assert.strictEqual(approved.status, 0, output(approved));
  });

  test('AC-P5-5 fast_lane fails the same gates as full_pipeline', () => {
    const fast = prepare('full_pipeline');
    const plain = prepare('full_pipeline');
    patchManifest(fast.run, (doc) => { doc.modifiers.fast_lane = true; });
    const fastWrite = writePlanFile(fast.repo, renderPlan({ specHash: fast.hash }));
    const plainWrite = writePlanFile(plain.repo, renderPlan({ specHash: plain.hash }));
    assert.strictEqual(fastWrite.status, 1, output(fastWrite));
    assert.strictEqual(plainWrite.status, 1, output(plainWrite));
    assert.match(output(fastWrite), /valid spec approval for the current revision: missing approvals\/spec.json/);
    assert.match(output(plainWrite), /valid spec approval for the current revision: missing approvals\/spec.json/);

    approveSpec(fast.run, 1, null);
    approveSpec(plain.run, 1, null);
    assert.strictEqual(writePlanFile(fast.repo, renderPlan({ specHash: fast.hash })).status, 0);
    assert.strictEqual(writePlanFile(plain.repo, renderPlan({ specHash: plain.hash })).status, 0);
    const fastApprove = sdd(['plan', 'approve', '--repo', fast.repo]);
    const plainApprove = sdd(['plan', 'approve', '--repo', plain.repo]);
    assert.strictEqual(fastApprove.status, 1, output(fastApprove));
    assert.strictEqual(plainApprove.status, 1, output(plainApprove));
    assert.match(output(fastApprove), /independent READY plan review for revision 1/);
    assert.match(output(plainApprove), /independent READY plan review for revision 1/);

    putReview(fast.run, 1, 'READY', { reviewer_kind: 'agent', independent: 'true' });
    putReview(plain.run, 1, 'READY', { reviewer_kind: 'agent', independent: 'true' });
    const fastAgent = sdd(['plan', 'approve', '--repo', fast.repo]);
    const plainAgent = sdd(['plan', 'approve', '--repo', plain.repo]);
    assert.strictEqual(fastAgent.status, 1, output(fastAgent));
    assert.strictEqual(plainAgent.status, 1, output(plainAgent));
    assert.match(output(fastAgent), /independent READY plan review for revision 1/);
    assert.match(output(plainAgent), /independent READY plan review for revision 1/);

    putPlan(fast.run, 1, renderPlan({ specHash: fast.hash, tasks: task('T-1', { status: 'in_progress' }) }));
    putPlan(plain.run, 1, renderPlan({ specHash: plain.hash, tasks: task('T-1', { status: 'in_progress' }) }));
    const fastTask = checkPlan(fast.repo);
    const plainTask = checkPlan(plain.repo);
    assert.strictEqual(fastTask.status, 1, output(fastTask));
    assert.strictEqual(plainTask.status, 1, output(plainTask));
    assert.match(output(fastTask), /T-1 cannot be in_progress without a plan approval/);
    assert.match(output(plainTask), /T-1 cannot be in_progress without a plan approval/);
  });

  test('AC-P4-2 full_pipeline in_progress fails while the spec approval does not cover the current revision', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    const started = task('T-1', { status: 'in_progress' });
    putPlan(run, 1, renderPlan({ specHash: hash, tasks: started }));
    const draft = checkPlan(repo);
    assert.strictEqual(draft.status, 1, output(draft));
    assert.match(output(draft), /T-1 cannot be in_progress without a plan approval/);
    assert.match(output(draft), /T-1 cannot be in_progress without a valid execution spec approval \(missing approvals\/spec.json\)/);

    approveSpec(run, 1, null);
    const specOnly = checkPlan(repo);
    assert.strictEqual(specOnly.status, 1, output(specOnly));
    assert.match(output(specOnly), /without a plan approval/);
    assert.doesNotMatch(output(specOnly), /execution spec approval/);

    const planFile = path.join(run, 'plan', 'revisions', 'r1.md');
    writeJson(path.join(run, 'approvals', 'plan.json'), {
      artifact: 'plan',
      revision: 1,
      content_hash: revisionHash(fs.readFileSync(planFile)),
      based_on_spec: { revision: 1, content_hash: hash },
      approved_at: '2026-09-26T00:00:00.000Z',
      carried_from: null,
      auto_commit: false,
    });
    const covered = checkPlan(repo);
    assert.strictEqual(covered.status, 0, output(covered));

    const approval = readJson(path.join(run, 'approvals', 'spec.json'));
    approval.content_hash = 'sha256:not-the-spec';
    writeJson(path.join(run, 'approvals', 'spec.json'), approval);
    const mismatch = checkPlan(repo);
    assert.strictEqual(mismatch.status, 1, output(mismatch));
    assert.match(output(mismatch), /execution spec approval \(approvals\/spec.json: spec\/revisions\/r1.md hash mismatch\)/);

    approval.content_hash = hash;
    approval.carried_from = { revision: 1, impact: 'spec/impact/r1.md' };
    writeJson(path.join(run, 'approvals', 'spec.json'), approval);
    const broken = checkPlan(repo);
    assert.strictEqual(broken.status, 1, output(broken));
    assert.match(output(broken), /carried_from is invalid/);
  });

  test('AC-P5-8 a dependent task cannot be in_progress until each required check passes', () => {
    const { repo, run, hash } = prepare();
    const tasks = task('T-1', { acceptance: 'AC-1' }) + task('T-2', {
      paths: 'src/b.ts',
      depends: 'T-1',
      status: 'in_progress',
    });
    putPlan(run, 1, renderPlan({ specHash: hash, tasks }));
    const missing = checkPlan(repo);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /T-2 depends on T-1 but AC-1 has no evidence/);

    const dir = path.join(run, 'evidence', 'AC-1');
    fs.mkdirSync(dir, { recursive: true });
    function putMeta(fields, outputText) {
      writeJson(path.join(dir, 'meta.json'), { ac: 'AC-1', stale: false, preexisting: false, ...fields });
      const output = path.join(dir, 'output.txt');
      if (outputText === undefined) {
        if (fs.existsSync(output)) fs.unlinkSync(output);
      } else {
        fs.writeFileSync(output, outputText);
      }
    }
    for (const status of ['fail', 'not_run', 'blocked']) {
      putMeta({ status }, 'ran\n');
      const result = checkPlan(repo);
      assert.strictEqual(result.status, 1, output(result));
      assert.match(output(result), new RegExp(`T-2 depends on T-1 but AC-1 is ${status}`));
    }
    putMeta({ status: 'pass', stale: true }, 'ran\n');
    const stale = checkPlan(repo);
    assert.strictEqual(stale.status, 1, output(stale));
    assert.match(output(stale), /AC-1 is stale/);
    putMeta({ status: 'pass', preexisting: true }, undefined);
    const borrowed = checkPlan(repo);
    assert.strictEqual(borrowed.status, 1, output(borrowed));
    assert.match(output(borrowed), /AC-1 has no evidence for this run/);
    putMeta({ status: 'fail', preexisting: true }, 'ran\n');
    const stillFail = checkPlan(repo);
    assert.strictEqual(stillFail.status, 1, output(stillFail));
    assert.match(output(stillFail), /AC-1 is fail/);
    putMeta({ status: 'pass', preexisting: true }, 'ran\n');
    const marked = checkPlan(repo);
    assert.doesNotMatch(output(marked), /depends on T-1 but AC-1 (is|has)/);
    assert.match(output(marked), /preexisting is not confirmed/);
    putMeta({ status: 'pass', preexisting: false }, 'ran\n');
    const ready = checkPlan(repo);
    assert.strictEqual(ready.status, 0, output(ready));
  });

  test('an in_progress task lists plan, spec, and dependency failures together', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    const tasks = task('T-1') + task('T-2', { paths: 'src/b.ts', depends: 'T-1', status: 'in_progress' });
    putPlan(run, 1, renderPlan({ specHash: hash, tasks }));
    const result = checkPlan(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /T-2 cannot be in_progress without a plan approval/);
    assert.match(output(result), /T-2 cannot be in_progress without a valid execution spec approval/);
    assert.match(output(result), /T-2 depends on T-1 but AC-1 has no evidence/);
  });

  test('plan write redacts secret shapes and refuses to overwrite a frozen revision', () => {
    const { repo, run, hash } = prepare();
    const akia = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const written = writePlanFile(repo, renderPlan({ specHash: hash, overrides: { goals: `ship ${akia}\n` } }));
    assert.strictEqual(written.status, 0, output(written));
    const stored = fs.readFileSync(path.join(run, 'plan', 'plan.md'), 'utf8');
    assert.match(stored, /\[redacted\]/);
    assert.strictEqual(stored.includes(akia), false);
    const again = writePlanFile(repo, renderPlan({ specHash: hash, overrides: { goals: 'ship something else\n' } }));
    assert.strictEqual(again.status, 1, output(again));
    assert.match(output(again), /r1\.md is frozen/);
    assert.strictEqual(fs.readFileSync(path.join(run, 'plan', 'plan.md'), 'utf8'), stored);
  });

  function putPlanImpact(run, revision, items) {
    const body = `${items.map((item) => `- section: ${item.section}\n  impact: ${item.impact}\n  reason: ${item.reason}\n`).join('\n')}\n`;
    const file = path.join(run, 'plan', 'impact', `r${revision}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }

  test('a plan approval carries when the impact lists every harmless diff', () => {
    const { repo, run, hash } = prepare();
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash, overrides: { notes: 'first\n' } })).status, 0);
    assert.strictEqual(sdd(['plan', 'approve', '--repo', repo, '--auto-commit']).status, 0);
    assert.strictEqual(writePlanFile(repo, renderPlan({ revision: 2, specHash: hash, overrides: { notes: 'second\n' } })).status, 0);
    putPlanImpact(run, 2, [{ section: 'notes', impact: 'none', reason: 'wording only' }]);
    const changed = sdd(['plan', 'approve', '--repo', repo, '--carry-from', '1']);
    assert.strictEqual(changed.status, 1, output(changed));
    assert.match(output(changed), /auto_commit change cannot carry a plan approval/);
    assert.strictEqual(readJson(path.join(run, 'approvals', 'plan.json')).revision, 1);
    const carried = sdd(['plan', 'approve', '--repo', repo, '--carry-from', '1', '--auto-commit']);
    assert.strictEqual(carried.status, 0, output(carried));
    const doc = readJson(path.join(run, 'approvals', 'plan.json'));
    assert.strictEqual(doc.revision, 2);
    assert.strictEqual(doc.auto_commit, true);
    assert.deepStrictEqual(doc.carried_from, { revision: 1, impact: 'plan/impact/r2.md' });
    assert.strictEqual(checkPlan(repo).status, 0);
    fs.writeFileSync(path.join(run, 'plan', 'impact', 'r2.md'), '- section: goals\n  impact: none\n  reason: wrong section\n');
    const omitted = checkPlan(repo);
    assert.strictEqual(omitted.status, 1, output(omitted));
    assert.match(output(omitted), /plan\/impact\/r2.md: missing section notes/);
  });

  test('plan carry fails when a non-carry section changed or the impact omits a diff', () => {
    const scoped = prepare();
    assert.strictEqual(writePlanFile(scoped.repo, renderPlan({ specHash: scoped.hash })).status, 0);
    assert.strictEqual(sdd(['plan', 'approve', '--repo', scoped.repo]).status, 0);
    assert.strictEqual(writePlanFile(scoped.repo, renderPlan({ revision: 2, specHash: scoped.hash, overrides: { scope: 'payments\n' } })).status, 0);
    putPlanImpact(scoped.run, 2, [{ section: 'scope', impact: 'none', reason: 'renamed' }]);
    const refused = sdd(['plan', 'approve', '--repo', scoped.repo, '--carry-from', '1']);
    assert.strictEqual(refused.status, 1, output(refused));
    assert.match(output(refused), /cannot carry scope/);
    assert.strictEqual(readJson(path.join(scoped.run, 'approvals', 'plan.json')).revision, 1);

    const partial = prepare();
    assert.strictEqual(writePlanFile(partial.repo, renderPlan({ specHash: partial.hash })).status, 0);
    assert.strictEqual(sdd(['plan', 'approve', '--repo', partial.repo]).status, 0);
    const next = renderPlan({
      revision: 2,
      specHash: partial.hash,
      overrides: { notes: 'second\n', goals: 'ship payments\n' },
    });
    assert.strictEqual(writePlanFile(partial.repo, next).status, 0);
    putPlanImpact(partial.run, 2, [{ section: 'notes', impact: 'none', reason: 'wording only' }]);
    const missing = sdd(['plan', 'approve', '--repo', partial.repo, '--carry-from', '1']);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /missing section goals/);
    assert.strictEqual(readJson(path.join(partial.run, 'approvals', 'plan.json')).carried_from, null);

    const full = prepare('full_pipeline');
    approveSpec(full.run, 1, null);
    assert.strictEqual(writePlanFile(full.repo, renderPlan({ specHash: full.hash, overrides: { notes: 'first\n' } })).status, 0);
    putReview(full.run, 1);
    assert.strictEqual(sdd(['plan', 'approve', '--repo', full.repo]).status, 0);
    assert.strictEqual(writePlanFile(full.repo, renderPlan({ revision: 2, specHash: full.hash, overrides: { notes: 'second\n' } })).status, 0);
    putPlanImpact(full.run, 2, [{ section: 'notes', impact: 'none', reason: 'wording only' }]);
    const reused = sdd(['plan', 'approve', '--repo', full.repo, '--carry-from', '1']);
    assert.strictEqual(reused.status, 0, output(reused));
    assert.strictEqual(fs.existsSync(path.join(full.run, 'review', 'plan-review-r2.md')), false);
    assert.strictEqual(readJson(path.join(full.run, 'approvals', 'plan.json')).carried_from.revision, 1);
  });

  test('AC-P5-4 a third automatic review is refused and the spec is left untouched', () => {
    const { repo, run, hash } = prepare('full_pipeline');
    approveSpec(run, 1, null);
    const specBytes = fs.readFileSync(path.join(run, 'spec', 'execution-spec.md'));
    const blocking = finding({
      id: 'F-1',
      basis: 'D1',
      location: 'tasks',
      severity: 'high',
      suggestion: 'narrow the task',
      resolution: 'split it',
      blocking: 'true',
    });
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash })).status, 0);
    putReview(run, 1, 'REVISE', { findings: blocking });
    assert.strictEqual(writePlanFile(repo, renderPlan({ revision: 2, specHash: hash, overrides: { notes: 'round 1\n' } })).status, 0);
    putReview(run, 2, 'REVISE', { findings: blocking });
    const once = sdd(['plan', 'revise', '--repo', repo]);
    assert.strictEqual(once.status, 0, output(once));
    assert.match(once.stdout, /revise allowed/);
    assert.deepStrictEqual(fs.readFileSync(path.join(run, 'spec', 'execution-spec.md')), specBytes);
    assert.strictEqual(writePlanFile(repo, renderPlan({ revision: 3, specHash: hash, overrides: { notes: 'round 2\n' } })).status, 0);
    putReview(run, 3, 'REVISE', { findings: blocking });
    const stopped = sdd(['plan', 'revise', '--repo', repo]);
    assert.strictEqual(stopped.status, 1, output(stopped));
    assert.match(output(stopped), /2 rounds already used and blocking findings remain/);
    assert.deepStrictEqual(fs.readFileSync(path.join(run, 'spec', 'execution-spec.md')), specBytes);
    assert.match(fs.readFileSync(path.join(run, 'spec', 'execution-spec.md'), 'utf8'), /id: R-1/);
  });

  test('AC-P5-11 a context list goes stale when the plan revision changes', () => {
    const { repo, run, hash } = prepare();
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash })).status, 0);
    fs.mkdirSync(path.join(run, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(run, 'scratch', 'chat.md'), 'planner said\n');
    const listed = sdd(['context', '--repo', repo, '--role', 'plan-reviewer']);
    assert.strictEqual(listed.status, 0, output(listed));
    const file = path.join(run, 'context', 'plan-reviewer.json');
    const fresh = readJson(file);
    assert.strictEqual(fresh.stale, false);
    assert.strictEqual(fresh.context_id, 'plan-reviewer');
    assert.strictEqual(fresh.items.some((entry) => entry.slot === 'plan' && entry.revision === 1), true);
    assert.strictEqual(fresh.items.some((entry) => String(entry.path).includes('scratch')), false);
    const quiet = sdd(['check', '--repo', repo]);
    assert.strictEqual(quiet.status, 0, output(quiet));
    assert.strictEqual(readJson(file).stale, false);
    assert.doesNotMatch(quiet.stdout, /stale context/);
    assert.strictEqual(writePlanFile(repo, renderPlan({ revision: 2, specHash: hash, overrides: { notes: 'later\n' } })).status, 0);
    const drifted = sdd(['check', '--repo', repo]);
    assert.strictEqual(drifted.status, 0, output(drifted));
    assert.match(drifted.stdout, /stale context plan-reviewer/);
    assert.strictEqual(readJson(file).stale, true);
    assert.strictEqual(readJson(file).items.find((entry) => entry.slot === 'plan').revision, 1);
    const again = sdd(['context', '--repo', repo, '--role', 'plan-reviewer']);
    assert.strictEqual(again.status, 0, output(again));
    assert.strictEqual(readJson(file).stale, false);
    assert.strictEqual(readJson(file).items.find((entry) => entry.slot === 'plan').revision, 2);
  });

  test('context lists stay inside the role and full_pipeline planner sees only an approved spec', () => {
    const { repo, run, hash } = prepare();
    const tasks = task('T-1', { paths: 'src/a.ts', acceptance: 'AC-1' }) + task('T-2', { paths: 'src/b.ts', acceptance: 'AC-1' });
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash, tasks })).status, 0);
    fs.mkdirSync(path.join(run, 'clarify'), { recursive: true });
    fs.writeFileSync(path.join(run, 'clarify', 'state.md'), [
      '<!-- sec:unknown -->',
      '- id: U-1',
      '  text: where the button lives',
      '- id: L-1',
      '  limit: true',
      '  text: no network',
      '',
    ].join('\n'));
    const missing = sdd(['context', '--repo', repo, '--role', 'executor']);
    assert.strictEqual(missing.status, 3, output(missing));
    const executor = sdd(['context', '--repo', repo, '--role', 'executor', '--task', 'T-1']);
    assert.strictEqual(executor.status, 0, output(executor));
    const doc = readJson(path.join(run, 'context', 'executor-T-1.json'));
    assert.strictEqual(doc.context_id, 'executor:T-1');
    assert.strictEqual(doc.items.some((entry) => entry.path === 'src/a.ts' && entry.id === 'T-1'), true);
    assert.strictEqual(doc.items.some((entry) => entry.path === 'src/b.ts'), false);
    assert.strictEqual(doc.items.some((entry) => entry.slot === 'acceptance:AC-1'), true);
    assert.strictEqual(doc.items.some((entry) => entry.slot === 'limit:L-1'), true);
    const scout = sdd(['context', '--repo', repo, '--role', 'scout']);
    assert.strictEqual(scout.status, 0, output(scout));
    const scoutDoc = readJson(path.join(run, 'context', 'scout.json'));
    assert.strictEqual(scoutDoc.items.some((entry) => entry.slot === 'unknown:U-1'), true);
    assert.strictEqual(scoutDoc.items.some((entry) => entry.slot === 'baseline'), true);
    assert.strictEqual(sdd(['context', '--repo', repo, '--role', 'nobody']).status, 3);

    const full = prepare('full_pipeline');
    const hidden = sdd(['context', '--repo', full.repo, '--role', 'planner']);
    assert.strictEqual(hidden.status, 0, output(hidden));
    const hiddenDoc = readJson(path.join(full.run, 'context', 'planner.json'));
    assert.strictEqual(hiddenDoc.items.some((entry) => entry.slot === 'spec'), false);
    approveSpec(full.run, 1, null);
    const shown = sdd(['context', '--repo', full.repo, '--role', 'planner']);
    assert.strictEqual(shown.status, 0, output(shown));
    const shownDoc = readJson(path.join(full.run, 'context', 'planner.json'));
    assert.strictEqual(shownDoc.items.some((entry) => entry.slot === 'spec' && entry.revision === 1), true);
    assert.strictEqual(shownDoc.items.some((entry) => entry.slot === 'interfaces'), true);
  });

  test('review write records plan and result reviews and rejects a finding that drops a field', () => {
    const { repo, run, hash } = prepare();
    assert.strictEqual(writePlanFile(repo, renderPlan({ specHash: hash })).status, 0);
    const findings = [
      checkedDimensions(),
      '',
      '- id: F-1',
      '  location: tasks',
      '  basis: D7',
      '  severity: high',
      '  suggestion: reject raw input',
      '  resolution: add a check',
      '  blocking: true',
      '',
    ].join('\n');
    const file = path.join(repo, 'findings.md');
    fs.writeFileSync(file, findings);
    const planReview = sdd([
      'review', 'write', '--repo', repo, '--kind', 'plan', '--verdict', 'REVISE',
      '--reviewer-kind', 'human', '--file', file,
    ]);
    assert.strictEqual(planReview.status, 0, output(planReview));
    const planText = fs.readFileSync(path.join(run, 'review', 'plan-review-r1.md'), 'utf8');
    assert.match(planText, /^artifact: plan-review$/m);
    assert.match(planText, /^verdict: REVISE$/m);
    assert.match(planText, /^reviewer_kind: human$/m);
    assert.match(planText, /location: tasks/);
    assert.match(planText, /basis: D7/);
    assert.match(planText, /severity: high/);
    assert.match(planText, /suggestion: reject raw input/);
    assert.match(planText, /resolution: add a check/);
    assert.match(planText, /blocking: true/);
    const resultReview = sdd([
      'review', 'write', '--repo', repo, '--kind', 'result', '--verdict', 'READY',
      '--reviewer-kind', 'agent', '--independent', '--context-id', 'reviewer-1', '--file', file,
    ]);
    assert.strictEqual(resultReview.status, 0, output(resultReview));
    const resultText = fs.readFileSync(path.join(run, 'review', 'result-review-r1.md'), 'utf8');
    assert.match(resultText, /^artifact: result-review$/m);
    assert.match(resultText, /^independent: true$/m);
    assert.match(resultText, /^context_id: reviewer-1$/m);

    const broken = path.join(repo, 'broken.md');
    fs.writeFileSync(broken, findings.replace('  blocking: true\n', ''));
    const before = fs.readFileSync(path.join(run, 'review', 'plan-review-r1.md'));
    const rejected = sdd([
      'review', 'write', '--repo', repo, '--kind', 'plan', '--verdict', 'READY',
      '--reviewer-kind', 'human', '--file', broken,
    ]);
    assert.strictEqual(rejected.status, 1, output(rejected));
    assert.match(output(rejected), /F-1 missing blocking/);
    assert.deepStrictEqual(fs.readFileSync(path.join(run, 'review', 'plan-review-r1.md')), before);
    const usage = sdd(['review', 'write', '--repo', repo, '--kind', 'note', '--verdict', 'READY', '--reviewer-kind', 'human']);
    assert.strictEqual(usage.status, 3, output(usage));
  });
};
