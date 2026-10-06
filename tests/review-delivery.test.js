'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson } = require('../lib/fsutil');
const { writeReview, loadReview, carryReview } = require('../lib/review');
const { captureReviewBinding, reviewBindingProblems } = require('../lib/review-binding');
const { latestPrepare, prepareProblems } = require('../lib/prepare');
const { revisionHash } = require('../lib/revision');
const { SPEC_KEYS } = require('../lib/spec');
const { PLAN_KEYS } = require('../lib/plan');

const BIN = path.join(__dirname, '..', 'bin', 'sdd.js');
function sdd(args) { return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 600000 }); }
function output(result) { return `${result.stdout || ''}${result.stderr || ''}`; }

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-review-delivery-')));
  spawnSync('git', ['init', '-q'], { cwd: root, timeout: 600000 });
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'need.md'), 'need\n');
  return root;
}

function tempInput(name, content) {
  const file = path.join(os.tmpdir(), `sdd-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(file, content);
  return file;
}

function specText() {
  const sections = {
    sources: 'docs/need.md', scope: 'button', requirements: '- id: R-1\n  text: show button',
    acceptance: '- id: AC-1\n  requirement: R-1\n  kind: normal\n  given: page\n  when: click\n  then: dialog\n  pass: visible',
  };
  return `---\nartifact: execution-spec\nrevision: 1\nstatus: draft\n---\n\n${SPEC_KEYS.map((key) => `<!-- sec:${key} -->\n${sections[key] || ''}\n`).join('\n')}`;
}

function planText(specHash) {
  const sections = {
    goals: 'ship button', scope: 'button', paths: 'src/a.ts',
    tasks: '- id: T-1\n  purpose: add button\n  paths: src/a.ts\n  integrator: planner\n  depends: \n  acceptance: AC-1\n  commit: button\n  preexisting_overlap: \n  reason: \n  status: pending',
    verification: '- id: AC-1\n  method: manual',
  };
  return `---\nartifact: plan\nrevision: 1\nstatus: draft\nbased_on:\n  artifact: execution-spec\n  revision: 1\n  content_hash: ${specHash}\n---\n\n${PLAN_KEYS.map((key) => `<!-- sec:${key} -->\n${sections[key] || ''}\n`).join('\n')}`;
}

module.exports = function reviewDeliveryTests(test) {
  test('result review binding detects same-size changes to an unknown large file and archives a re-review', () => {
    const root = repo();
    const runDir = path.join(root, '.sdd-dev', 'runs', 'r1');
    fs.mkdirSync(path.join(runDir, 'review'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'evidence', 'AC-1'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'evidence', 'AC-1', 'output.txt'), 'pass\n');
    const large = path.join(root, 'large.bin');
    fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1, 0x61));
    const manifest = { run_id: 'r1', workspaces: [{ id: 'app', path: '.' }] };
    const binding = captureReviewBinding(root, runDir, manifest);
    assert.strictEqual(binding.workspaces[0].codebase_ref.unknown.some((item) => item.path === 'large.bin'), true);
    writeReview(runDir, { kind: 'result', revision: 1, verdict: 'READY', reviewerKind: 'agent', independent: true, contextId: 'reviewer', text: '', repoRoot: root, manifest });
    const first = loadReview(runDir, 'result-review', 1);
    assert.deepStrictEqual(reviewBindingProblems(root, runDir, first, manifest), []);
    fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1, 0x62));
    assert.match(reviewBindingProblems(root, runDir, first, manifest).join(' '), /成果已變更/);
    writeReview(runDir, { kind: 'result', revision: 1, verdict: 'READY', reviewerKind: 'agent', independent: true, contextId: 'reviewer', text: '', repoRoot: root, manifest });
    assert.strictEqual(fs.existsSync(path.join(runDir, 'review', 'archive', 'result-review-r1-v1.md')), true);
    assert.strictEqual(fs.existsSync(path.join(runDir, 'review', 'archive', 'result-review-r1-v1.binding.json')), true);
    assert.deepStrictEqual(reviewBindingProblems(root, runDir, loadReview(runDir, 'result-review', 1), manifest), []);
    fs.writeFileSync(path.join(runDir, 'evidence', 'AC-1', 'output.txt'), 'fail\n');
    assert.match(reviewBindingProblems(root, runDir, loadReview(runDir, 'result-review', 1), manifest).join(' '), /驗收證據已變更/);
  });

  test('selected advisors prepare records research uncertainty, keeps versions, and checks source drift', () => {
    const root = repo();
    assert.strictEqual(sdd(['init', '--repo', root, '--mode', 'repo-local', '--tracking', 'ignore']).status, 0);
    const opened = sdd(['run', 'start', '--repo', root, '--workspace', 'app', '--route', 'selected_advisors', '--source', 'docs/need.md']);
    assert.strictEqual(opened.status, 0, output(opened));
    const id = opened.stdout.match(/^run (\S+)/m)[1];
    const runDir = path.join(root, '.sdd-dev', 'runs', id);
    const input = path.join(os.tmpdir(), `sdd-review-input-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(input, JSON.stringify({
      read_scope: ['docs/need.md'],
      findings: [],
      unconfirmed: [{ claim: '需求範圍', reason: '缺少使用者答覆', evidence: '缺少決策紀錄', impact: '諮詢結論' }],
    }));
    const prepared = sdd(['review', 'prepare', '--repo', root, '--run', id, '--file', input]);
    assert.strictEqual(prepared.status, 0, output(prepared));
    const first = latestPrepare(runDir);
    assert.strictEqual(first.rel, 'review/prepare-v1.json');
    assert.strictEqual(first.receipt.research_recorded, true);
    assert.strictEqual(first.receipt.unconfirmed[0].reason, '缺少使用者答覆');
    assert.strictEqual(first.receipt.inputs.plan, null);
    assert.strictEqual(first.receipt.inputs.result, null);
    const manifest = readJson(path.join(runDir, 'manifest.json'));
    assert.deepStrictEqual(prepareProblems(root, runDir, id, manifest), []);
    fs.writeFileSync(input, JSON.stringify({ read_scope: ['docs/need.md'], findings: [] }));
    assert.strictEqual(sdd(['review', 'prepare', '--repo', root, '--run', id, '--file', input]).status, 0);
    assert.strictEqual(latestPrepare(runDir).rel, 'review/prepare-v2.json');
    assert.strictEqual(latestPrepare(runDir).receipt.research_recorded, false);
    assert.strictEqual(fs.existsSync(path.join(runDir, 'review', 'prepare-v1.json')), true);
    fs.writeFileSync(path.join(root, 'docs', 'need.md'), 'changed\n');
    assert.match(prepareProblems(root, runDir, id, manifest).join(' '), /sources changed/);
    fs.unlinkSync(input);
  });

  test('direct prepare remains current after a new result review and expires when code changes', () => {
    const root = repo();
    assert.strictEqual(sdd(['init', '--repo', root, '--mode', 'repo-local', '--tracking', 'ignore']).status, 0);
    const opened = sdd(['run', 'start', '--repo', root, '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md']);
    assert.strictEqual(opened.status, 0, output(opened));
    const id = opened.stdout.match(/^run (\S+)/m)[1];
    const runDir = path.join(root, '.sdd-dev', 'runs', id);
    const specFile = tempInput('spec', specText());
    assert.strictEqual(sdd(['spec', 'write', '--repo', root, '--run', id, '--file', specFile]).status, 0);
    const specHash = revisionHash(fs.readFileSync(path.join(runDir, 'spec', 'revisions', 'r1.md')));
    const planFile = tempInput('plan', planText(specHash));
    const planned = sdd(['plan', 'write', '--repo', root, '--run', id, '--file', planFile]);
    assert.strictEqual(planned.status, 0, output(planned));
    const evidenceFile = tempInput('evidence', 'manual check passed\n');
    assert.strictEqual(sdd(['evidence', 'write', '--repo', root, '--run', id, '--ac', 'AC-1', '--file', evidenceFile]).status, 0);
    const verified = sdd(['verify', '--repo', root, '--run', id, '--ac', 'AC-1']);
    assert.strictEqual(verified.status, 0, output(verified));
    const reviewInput = tempInput('review', JSON.stringify({ read_scope: ['docs/need.md'], findings: [], unconfirmed: [] }));
    const prepared = sdd(['review', 'prepare', '--repo', root, '--run', id, '--file', reviewInput]);
    assert.strictEqual(prepared.status, 0, output(prepared));
    const manifest = readJson(path.join(runDir, 'manifest.json'));
    assert.deepStrictEqual(prepareProblems(root, runDir, id, manifest), []);
    const reviewFile = tempInput('findings', '');
    const reviewed = sdd(['review', 'write', '--repo', root, '--run', id, '--kind', 'result', '--verdict', 'READY', '--reviewer-kind', 'agent', '--independent', '--context-id', 'reviewer', '--file', reviewFile]);
    assert.strictEqual(reviewed.status, 0, output(reviewed));
    assert.deepStrictEqual(prepareProblems(root, runDir, id, manifest), []);
    const listed = sdd(['context', '--repo', root, '--run', id, '--role', 'verifier']);
    assert.strictEqual(listed.status, 0, output(listed));
    const context = readJson(path.join(runDir, 'context', 'verifier.json'));
    assert.strictEqual(context.items.some((item) => item.path === 'review/prepare-v1.json'), true);
    assert.strictEqual(context.items.some((item) => item.path === 'review/result-review-r1.binding.json'), true);
    const next = sdd(['run', 'next', '--repo', root, '--run', id, '--json']);
    assert.strictEqual(next.status, 0, output(next));
    assert.strictEqual(JSON.parse(next.stdout).action, 'run_done');
    const done = sdd(['run', 'done', '--repo', root, '--run', id]);
    assert.strictEqual(done.status, 0, output(done));
    assert.match(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8'), /已完成/);
    fs.writeFileSync(path.join(root, 'src.ts'), 'change\n');
    assert.match(prepareProblems(root, runDir, id, manifest).join(' '), /成果已變更/);
    for (const file of [specFile, planFile, evidenceFile, reviewInput, reviewFile]) fs.unlinkSync(file);
  });

  test('prepare rejects invalid references and unexpected input fields before saving a receipt', () => {
    const root = repo();
    assert.strictEqual(sdd(['init', '--repo', root, '--mode', 'repo-local', '--tracking', 'ignore']).status, 0);
    const opened = sdd(['run', 'start', '--repo', root, '--workspace', 'app', '--route', 'selected_advisors', '--source', 'docs/need.md']);
    const id = opened.stdout.match(/^run (\S+)/m)[1];
    const runDir = path.join(root, '.sdd-dev', 'runs', id);
    const file = tempInput('invalid-review', JSON.stringify({ read_scope: ['missing.md'], findings: [] }));
    const missing = sdd(['review', 'prepare', '--repo', root, '--run', id, '--file', file]);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /read_scope reference is not a file/);
    fs.writeFileSync(file, JSON.stringify({ read_scope: [], findings: [], trusted: true }));
    const extra = sdd(['review', 'prepare', '--repo', root, '--run', id, '--file', file]);
    assert.strictEqual(extra.status, 1, output(extra));
    assert.match(output(extra), /unknown field trusted/);
    assert.strictEqual(latestPrepare(runDir), null);
    fs.unlinkSync(file);
  });

  test('result review carry retains the original binding and refuses changed results', () => {
    const root = repo();
    const runDir = path.join(root, '.sdd-dev', 'runs', 'r1');
    fs.mkdirSync(path.join(runDir, 'review'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'plan', 'revisions'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'plan', 'impact'), { recursive: true });
    const manifest = { run_id: 'r1', route: 'direct', workspaces: [{ id: 'app', path: '.' }] };
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
    const r1 = planText('sha256:spec');
    const r2 = r1.replace('revision: 1\nstatus: draft', 'revision: 2\nstatus: draft')
      .replace('<!-- sec:notes -->\n', '<!-- sec:notes -->\nwording\n');
    fs.writeFileSync(path.join(runDir, 'plan', 'revisions', 'r1.md'), r1);
    fs.writeFileSync(path.join(runDir, 'plan', 'revisions', 'r2.md'), r2);
    fs.writeFileSync(path.join(runDir, 'plan', 'plan.md'), r1);
    writeReview(runDir, { kind: 'result', revision: 1, verdict: 'READY', reviewerKind: 'agent', independent: true, contextId: 'reviewer', text: '', repoRoot: root, manifest });
    const original = readJson(path.join(runDir, 'review', 'result-review-r1.binding.json'));
    fs.writeFileSync(path.join(runDir, 'plan', 'plan.md'), r2);
    fs.writeFileSync(path.join(runDir, 'plan', 'impact', 'r2.md'), '- section: notes\n  impact: none\n  reason: wording only\n');
    const carried = carryReview(runDir, { kind: 'result', from: 1, repoRoot: root });
    assert.strictEqual(carried.rel, 'review/result-review-r2.md');
    assert.deepStrictEqual(readJson(path.join(runDir, 'review', 'result-review-r2.binding.json')), original);
    fs.writeFileSync(path.join(root, 'changed.txt'), 'new result\n');
    assert.throws(() => carryReview(runDir, { kind: 'result', from: 1, repoRoot: root }), /成果已變更/);
    assert.deepStrictEqual(readJson(path.join(runDir, 'review', 'result-review-r2.binding.json')), original);
  });

  test('prepare rejects edited frozen revisions and malformed check records', () => {
    const root = repo();
    const runDir = path.join(root, '.sdd-dev', 'runs', 'r1');
    fs.mkdirSync(path.join(runDir, 'review'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'spec', 'revisions'), { recursive: true });
    const manifest = { run_id: 'r1', route: 'selected_advisors', workspaces: [{ id: 'app', path: '.' }], sources: [{ path: 'docs/need.md', origin: 'file', id: 'source' }] };
    const spec = specText();
    fs.writeFileSync(path.join(runDir, 'spec', 'execution-spec.md'), spec);
    fs.writeFileSync(path.join(runDir, 'spec', 'revisions', 'r1.md'), spec);
    const { writePrepare } = require('../lib/prepare');
    const written = writePrepare(root, runDir, 'r1', manifest, { config: path.join(root, '.sdd-dev', 'config') }, { read_scope: ['docs/need.md'], findings: [] });
    assert.deepStrictEqual(prepareProblems(root, runDir, 'r1', manifest), []);
    const receiptFile = path.join(runDir, written.rel);
    const receipt = readJson(receiptFile);
    receipt.checks = [{ name: 'run_integrity', status: 'pass', problems: [] }];
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    assert.match(prepareProblems(root, runDir, 'r1', manifest).join(' '), /required checks are missing/);
    fs.writeFileSync(receiptFile, JSON.stringify(written.receipt));
    fs.writeFileSync(path.join(runDir, 'spec', 'revisions', 'r1.md'), `${spec}\nchanged`);
    assert.match(prepareProblems(root, runDir, 'r1', manifest).join(' '), /Spec, Plan or sources changed/);
  });
};
