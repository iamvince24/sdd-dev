'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson, walk } = require('../lib/fsutil');
const { revisionHash } = require('../lib/revision');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');
const AKIA = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const KEYS = [
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
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p4-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function install(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

function start(repo) {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
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

function renderSpec(revision, overrides = {}, omit = []) {
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
  const body = KEYS
    .filter((key) => !omit.includes(key))
    .map((key) => {
      const text = sections[key].endsWith('\n') ? sections[key] : `${sections[key]}\n`;
      return `<!-- sec:${key} -->\n${text}`;
    })
    .join('\n');
  return `---\nartifact: execution-spec\nrevision: ${revision}\nstatus: draft\n---\n\n${body}`;
}

function putSpec(run, revision, text) {
  const file = path.join(run, 'spec', 'revisions', `r${revision}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(run, 'spec', 'execution-spec.md'), text);
}

function putImpact(run, revision, items) {
  const body = `${items.map((item) => `- section: ${item.section}\n  impact: ${item.impact}\n  reason: ${item.reason}\n`).join('\n')}\n`;
  const file = path.join(run, 'spec', 'impact', `r${revision}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function approve(run, revision, carriedFrom) {
  const file = path.join(run, 'spec', 'revisions', `r${revision}.md`);
  writeJson(path.join(run, 'approvals', 'spec.json'), {
    artifact: 'execution-spec',
    revision,
    content_hash: revisionHash(fs.readFileSync(file)),
    approved_at: '2026-09-26T00:00:00.000Z',
    carried_from: carriedFrom,
  });
}

function checkSpec(repo) {
  return sdd(['check', '--stage', 'spec', '--repo', repo]);
}

module.exports = function p4Tests(test) {
  test('a short direct spec with an acceptance passes check --stage spec', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    const run = runPath(repo, id);
    const file = path.join(repo, 'spec.md');
    fs.writeFileSync(file, renderSpec(1));
    const written = sdd(['spec', 'write', '--repo', repo, '--file', file]);
    assert.strictEqual(written.status, 0, output(written));
    assert.match(written.stdout, new RegExp(`spec r1 ${id}`));
    assert.strictEqual(fs.readFileSync(path.join(run, 'spec', 'execution-spec.md'), 'utf8'), renderSpec(1));
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 0, output(result));
  });

  test('AC-P4-1 check --stage spec fails when a requirement has no acceptance', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    putSpec(runPath(repo, id), 1, renderSpec(1, { acceptance: '\n' }));
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /R-1 has no acceptance/);
  });

  test('AC-P4-3 an r1 approval does not cover r2 without carried_from', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    const run = runPath(repo, id);
    putSpec(run, 1, renderSpec(1));
    approve(run, 1, null);
    putSpec(run, 2, renderSpec(2, { sources: 'docs/need.md r2\n' }));
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /revision 1 does not cover current revision 2/);
    assert.strictEqual(readJson(path.join(run, 'approvals', 'spec.json')).revision, 1);
  });

  test('AC-P4-6 an r1 approval carries when only sources changed and the impact lists it', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    const run = runPath(repo, id);
    putSpec(run, 1, renderSpec(1));
    const r2 = renderSpec(2, { sources: 'docs/need.md r2\n' });
    fs.writeFileSync(path.join(run, 'spec', 'revisions', 'r2.md'), r2);
    fs.writeFileSync(path.join(run, 'spec', 'execution-spec.md'), r2);
    putImpact(run, 2, [{ section: 'sources', impact: 'none', reason: 'source id refresh' }]);
    approve(run, 2, { revision: 1, impact: 'spec/impact/r2.md' });
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 0, output(result));
  });

  test('AC-P4-7 carried_from fails when acceptance changed', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    const run = runPath(repo, id);
    putSpec(run, 1, renderSpec(1));
    const r2 = renderSpec(2, {
      acceptance: [
        '- id: AC-1',
        '  requirement: R-1',
        '  kind: error',
        '  given: a page',
        '  when: the user clicks',
        '  then: it stays closed',
        '  pass: no dialog',
        '',
      ].join('\n'),
    });
    fs.writeFileSync(path.join(run, 'spec', 'revisions', 'r2.md'), r2);
    fs.writeFileSync(path.join(run, 'spec', 'execution-spec.md'), r2);
    putImpact(run, 2, [{ section: 'acceptance', impact: 'none', reason: 'wording' }]);
    approve(run, 2, { revision: 1, impact: 'spec/impact/r2.md' });
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /cannot carry acceptance/);
  });

  test('AC-P4-8 carry fails when the impact omits a changed section', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    const run = runPath(repo, id);
    putSpec(run, 1, renderSpec(1));
    const r2 = renderSpec(2, {
      sources: 'docs/need.md r2\n',
      clarifications: 'asked once\n',
    });
    fs.writeFileSync(path.join(run, 'spec', 'revisions', 'r2.md'), r2);
    fs.writeFileSync(path.join(run, 'spec', 'execution-spec.md'), r2);
    putImpact(run, 2, [{ section: 'sources', impact: 'none', reason: 'source id refresh' }]);
    approve(run, 2, { revision: 1, impact: 'spec/impact/r2.md' });
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /missing section clarifications/);
  });

  test('AC-P4-9 check --stage spec fails when a deviation does not cite an answered Q-n', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    const run = runPath(repo, id);
    putSpec(run, 1, renderSpec(1, { deviations: '- id: DV-1\n  text: label changed\n' }));
    const missing = checkSpec(repo);
    assert.strictEqual(missing.status, 1, output(missing));
    assert.match(output(missing), /deviation missing Q-n/);

    putSpec(run, 1, renderSpec(1, { deviations: '- id: DV-1\n  decision: Q-1\n  text: label changed\n' }));
    const unanswered = checkSpec(repo);
    assert.strictEqual(unanswered.status, 1, output(unanswered));
    assert.match(output(unanswered), /deviation Q-1 is not answered/);

    fs.mkdirSync(path.join(run, 'clarify'), { recursive: true });
    fs.writeFileSync(path.join(run, 'clarify', 'decisions.md'), '- id: Q-1\n  answer: use the short label\n');
    const answered = checkSpec(repo);
    assert.strictEqual(answered.status, 0, output(answered));
  });

  test('AC-P4-10 check --stage spec fails when a required section marker is missing', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    putSpec(runPath(repo, id), 1, renderSpec(1, {}, ['constraints']));
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /missing section constraints/);
  });

  test('acceptance items need given, when, then, kind, and pass', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    putSpec(runPath(repo, id), 1, renderSpec(1, {
      acceptance: '- id: AC-1\n  requirement: R-1\n  kind: normal\n',
    }));
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /AC-1 missing given/);
    assert.match(output(result), /AC-1 missing pass/);
  });

  test('an overturned assumption lists the requirements and acceptances that cite it', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    putSpec(runPath(repo, id), 1, renderSpec(1, {
      assumptions: '- id: A-1\n  status: overturned\n',
      requirements: '- id: R-1\n  text: show the button while A-1 holds\n',
      acceptance: [
        '- id: AC-1',
        '  requirement: R-1',
        '  kind: normal',
        '  given: a page',
        '  when: the user clicks',
        '  then: A-1 is visible',
        '  pass: the dialog is visible',
        '',
      ].join('\n'),
    }));
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 0, output(result));
    assert.match(result.stdout, /note assumption A-1 overturned: R-1, AC-1/);
  });

  test('spec write redacts secret shapes and refuses to overwrite a frozen revision', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    const run = runPath(repo, id);
    const file = path.join(repo, 'spec.md');
    fs.writeFileSync(file, renderSpec(1, { sources: `docs/need.md ${AKIA}\n` }));
    const written = sdd(['spec', 'write', '--repo', repo, '--file', file]);
    assert.strictEqual(written.status, 0, output(written));
    const stored = fs.readFileSync(path.join(run, 'spec', 'execution-spec.md'), 'utf8');
    assert.match(stored, /\[redacted\]/);
    assert(!stored.includes(AKIA));
    for (const rel of walk(run)) {
      assert(!fs.readFileSync(path.join(run, rel)).includes(Buffer.from(AKIA)), rel);
    }
    assert.match(fs.readFileSync(path.join(run, 'problems.md'), 'utf8'), /## P-1/);
    fs.writeFileSync(file, renderSpec(1, { sources: 'docs/need.md changed\n' }));
    const again = sdd(['spec', 'write', '--repo', repo, '--file', file]);
    assert.strictEqual(again.status, 1, output(again));
    assert.match(output(again), /r1\.md is frozen/);
    assert.strictEqual(fs.readFileSync(path.join(run, 'spec', 'revisions', 'r1.md'), 'utf8'), stored);
  });

  test('check --stage spec fails when a frozen revision hash no longer matches the approval', () => {
    const repo = tmpRepo();
    install(repo);
    const id = start(repo);
    const run = runPath(repo, id);
    putSpec(run, 1, renderSpec(1));
    approve(run, 1, null);
    const revision = path.join(run, 'spec', 'revisions', 'r1.md');
    const before = fs.readFileSync(path.join(run, 'approvals', 'spec.json'));
    fs.writeFileSync(revision, fs.readFileSync(revision, 'utf8').replace('button', 'buttons'));
    const result = checkSpec(repo);
    assert.strictEqual(result.status, 1, output(result));
    assert.match(output(result), /spec\/revisions\/r1\.md hash mismatch/);
    assert.deepStrictEqual(fs.readFileSync(path.join(run, 'approvals', 'spec.json')), before);
  });
};
