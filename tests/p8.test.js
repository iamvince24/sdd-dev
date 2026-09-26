'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { readJson, writeJson } = require('../lib/fsutil');
const { evaluate } = require('../lib/cases');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');
const CASES = path.join(TOOL_ROOT, 'tests', 'fixtures', 'cases');

function sdd(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p8-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function install(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

function open(repo) {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'need.md'), 'need\n');
  const added = sdd(['workspace', 'add', '--repo', repo, '--id', 'app', '--path', '.', '--stack', 'node']);
  assert.strictEqual(added.status, 0, output(added));
  const started = sdd([
    'run', 'start', '--repo', repo, '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md',
  ]);
  assert.strictEqual(started.status, 0, output(started));
  const match = started.stdout.match(/^run (\S+)/m);
  assert(match, output(started));
  return { id: match[1], run: path.join(repo, '.sdd-dev', 'runs', match[1]) };
}

function specText(revision) {
  return [
    '---',
    'artifact: execution-spec',
    `revision: ${revision}`,
    'status: draft',
    '---',
    '',
    '<!-- sec:acceptance -->',
    '- id: AC-1',
    '  requirement: R-1',
    '',
  ].join('\n');
}

function writeSpec(repo, revision) {
  const file = path.join(repo, 'spec.md');
  fs.writeFileSync(file, specText(revision));
  const result = sdd(['spec', 'write', '--repo', repo, '--file', file]);
  assert.strictEqual(result.status, 0, output(result));
}

function writeEvidence(run, status) {
  const dir = path.join(run, 'evidence', 'AC-1');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'meta.json'), { ac: 'AC-1', status, stale: false, preexisting: false });
}

function loadCase(name) {
  return readJson(path.join(CASES, name));
}

module.exports = function p8Tests(test) {
  test('case fixtures follow this policy version and ignore file counts', () => {
    const names = fs.readdirSync(CASES).filter((name) => name.endsWith('.json')).sort();
    assert.deepStrictEqual(names, [
      'direct-recoverable.json',
      'external-interface.json',
      'preexisting-no-baseline.json',
      'verify-permission.json',
    ]);
    for (const name of names) {
      const doc = loadCase(name);
      assert.deepStrictEqual(evaluate(doc), doc.expect);
    }
    const direct = loadCase('direct-recoverable.json');
    assert.deepStrictEqual(evaluate({ ...direct, file_count: 1 }), direct.expect);
    assert.deepStrictEqual(evaluate({ ...direct, file_count: 40 }), direct.expect);
    const iface = loadCase('external-interface.json');
    assert.strictEqual(evaluate({ ...iface, file_count: 1 }).route, 'full_pipeline');
    const failed = loadCase('preexisting-no-baseline.json');
    assert.strictEqual(evaluate(failed).pass, false);
    assert.notStrictEqual(evaluate(failed).status, 'pass');
    const denied = loadCase('verify-permission.json');
    assert.strictEqual(evaluate(denied).method, 'unit');
    assert.notStrictEqual(evaluate(denied).method, denied.fallback);
  });

  test('AC-P8-1 waiting_ms and outcomes stay unknown when the platform has no measurement', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = open(repo);
    const wrote = sdd(['metrics', '--repo', repo]);
    assert.strictEqual(wrote.status, 0, output(wrote));
    const doc = readJson(path.join(run, 'metrics.json'));
    assert.strictEqual(doc.waiting_ms, 'unknown');
    assert.notStrictEqual(doc.waiting_ms, 0);
    assert.strictEqual(doc.active_ms, 'unknown');
    assert.strictEqual(doc.subagents, 'unknown');
    assert.strictEqual(doc.approval_requests, 'unknown');
    assert.strictEqual(doc.outcomes, 'unknown');
    assert.notDeepStrictEqual(doc.outcomes, []);
    assert.strictEqual(doc.risk_features, 'unknown');
    assert.notDeepStrictEqual(doc.risk_features, []);
    assert.deepStrictEqual(doc.escalations, []);
  });

  test('AC-P8-2 metrics derive the escalation from route_history', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = open(repo);
    const changed = sdd([
      'run', 'route', '--repo', repo, '--route', 'full_pipeline',
      '--reason', 'external interface', '--by', 'user',
    ]);
    assert.strictEqual(changed.status, 0, output(changed));
    assert.strictEqual(sdd(['metrics', '--repo', repo]).status, 0);
    const doc = readJson(path.join(run, 'metrics.json'));
    assert.strictEqual(doc.route_initial, 'direct');
    assert.strictEqual(doc.route_final, 'full_pipeline');
    assert.strictEqual(doc.escalations.length, 1);
    assert.strictEqual(doc.escalations[0].from, 'direct');
    assert.strictEqual(doc.escalations[0].to, 'full_pipeline');
    assert.strictEqual(doc.escalations[0].reason, 'external interface');
    assert.strictEqual(doc.escalations[0].by, 'user');
  });

  test('AC-P8-3 reporting one block twice still counts as 1', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = open(repo);
    const manifestPath = path.join(run, 'manifest.json');
    const manifest = readJson(manifestPath);
    const block = { id: 'B-1', affected: ['AC-1'], condition: 'need a decision', at: '2026-09-27T00:00:00.000Z' };
    manifest.blocks = [block, { ...block, at: '2026-09-27T01:00:00.000Z' }];
    writeJson(manifestPath, manifest);
    assert.strictEqual(sdd(['metrics', '--repo', repo]).status, 0);
    assert.strictEqual(readJson(path.join(run, 'metrics.json')).blocks, 1);
  });

  test('AC-P8-4 outcome appends after done and leaves first_pass_success', () => {
    const repo = tmpRepo();
    install(repo);
    const { id, run } = open(repo);
    writeSpec(repo, 1);
    writeEvidence(run, 'pass');
    assert.strictEqual(sdd(['metrics', '--repo', repo]).status, 0);
    const before = readJson(path.join(run, 'metrics.json'));
    assert.strictEqual(before.first_pass_success['1'], true);
    assert.strictEqual(before.outcomes, 'unknown');
    const manifestPath = path.join(run, 'manifest.json');
    const manifest = readJson(manifestPath);
    manifest.status = 'done';
    writeJson(manifestPath, manifest);
    const active = tmpRepo();
    install(active);
    open(active);
    const early = sdd(['metrics', 'outcome', '--repo', active, '--kind', 'revert', '--basis', 'too soon']);
    assert.strictEqual(early.status, 1, output(early));

    const reverted = sdd(['metrics', 'outcome', '--repo', repo, '--kind', 'revert', '--basis', 'ship broke']);
    assert.strictEqual(reverted.status, 0, output(reverted));
    const once = readJson(path.join(run, 'metrics.json'));
    assert.deepStrictEqual(once.first_pass_success, before.first_pass_success);
    assert.strictEqual(once.outcomes.length, 1);
    assert.strictEqual(once.outcomes[0].kind, 'revert');
    assert.strictEqual(once.outcomes[0].basis, 'ship broke');
    assert.strictEqual(typeof once.outcomes[0].observed_at, 'string');
    const again = sdd(['metrics', 'outcome', '--repo', repo, '--kind', 'reopen', '--basis', 'came back']);
    assert.strictEqual(again.status, 0, output(again));
    const twice = readJson(path.join(run, 'metrics.json'));
    assert.deepStrictEqual(twice.first_pass_success, before.first_pass_success);
    assert.strictEqual(twice.outcomes.length, 2);
    assert.strictEqual(twice.final_pass_success, true);
    assert.strictEqual(id.length > 0, true);
  });

  test('AC-P8-5 a new spec revision keeps the previous first_pass_success', () => {
    const repo = tmpRepo();
    install(repo);
    const { run } = open(repo);
    writeSpec(repo, 1);
    writeEvidence(run, 'pass');
    assert.strictEqual(sdd(['metrics', '--repo', repo]).status, 0);
    assert.strictEqual(readJson(path.join(run, 'metrics.json')).first_pass_success['1'], true);
    writeSpec(repo, 2);
    writeEvidence(run, 'fail');
    assert.strictEqual(sdd(['metrics', '--repo', repo]).status, 0);
    const doc = readJson(path.join(run, 'metrics.json'));
    assert.strictEqual(doc.first_pass_success['1'], true);
    assert.strictEqual(doc.first_pass_success['2'], false);
    assert.strictEqual(doc.final_pass_success, false);
    assert.strictEqual(doc.outcomes, 'unknown');
  });

  test('a test command the process cannot execute stays blocked without lowering the method', () => {
    const repo = tmpRepo();
    install(repo);
    const script = path.join(repo, 'noexec.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho hi\n');
    fs.chmodSync(script, 0o644);
    const { id, run } = open(repo);
    const profile = path.join(repo, '.sdd-dev', 'config', 'workspaces.json');
    const doc = readJson(profile);
    const unit = doc.workspaces[0].verify.find((item) => item.id === 'unit');
    unit.command = script;
    unit.absent = false;
    unit.reason = null;
    writeJson(profile, doc);
    fs.mkdirSync(path.join(run, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(run, 'plan', 'plan.md'), '---\nartifact: plan\nrevision: 1\n---\n\n<!-- sec:verification -->\n- id: AC-1\n  method: unit\n');
    const result = sdd(['verify', '--repo', repo, '--ac', 'AC-1']);
    assert.strictEqual(result.status, 0, output(result));
    const recorded = readJson(path.join(run, 'evidence', 'AC-1', 'meta.json'));
    assert.strictEqual(recorded.status, 'blocked');
    assert.strictEqual(recorded.method, 'unit');
    assert.strictEqual(recorded.reason, 'permission');
    assert.notStrictEqual(recorded.status, 'pass');
    assert.strictEqual(id.length > 0, true);
  });
};
