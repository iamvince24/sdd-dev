'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const guard = require('../lib/guard');
const instructions = require('../lib/instructions');
const claude = require('../integrations/claude-code/hook');
const { digestProgress } = require('../lib/hook-stop');
const { computeCodebase } = require('../lib/codebase');
const { readJson, writeJson } = require('../lib/fsutil');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'sdd.js');
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-security-c-')));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
function cli(root, args) { return spawnSync(process.execPath, [BIN, ...args, '--repo', root], { encoding: 'utf8' }); }
function init(root) {
  const result = cli(root, ['init', '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
}
function start(root) {
  init(root);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'need.md'), 'need\n');
  const ws = cli(root, ['workspace', 'add', '--id', 'app', '--path', '.', '--stack', 'node']);
  assert.strictEqual(ws.status, 0, `${ws.stdout}${ws.stderr}`);
  const result = cli(root, ['run', 'start', '--workspace', 'app', '--route', 'direct', '--source', 'docs/need.md']);
  assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.match(/^run (\S+)/m)[1];
}
function runHook(root, payload) {
  const file = path.join(ROOT, 'integrations', 'claude-code', 'hook.js');
  return spawnSync(process.execPath, [file], {
    cwd: root, input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
  });
}

module.exports = function securityCTests(test) {
  test('AC-17 agent shell classifier rejects grant add and human review impersonation', () => {
    for (const command of [
      'sdd grant add --op network --scope example --source Q-1',
      'npx sdd grant add --op network --scope example --source Q-1',
      'bash -c "sdd review write --reviewer-kind human --kind result"',
      'node /tmp/bin/sdd.js review write --kind result --reviewer-kind=human',
    ]) {
      assert.strictEqual(guard.classify(command).op, 'user_action', command);
    }
    const root = repo();
    start(root);
    assert.strictEqual(claude.evaluate(root, 'sdd grant add --op network --scope example --source Q-1').allow, false);
  });

  test('AC-13 CLAUDE bootstrap is shared and uninstall preserves user additions', () => {
    const root = repo(); init(root);
    const file = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(file, 'my instructions\n');
    instructions.installInto(root, 'claude-code', 'direct');
    instructions.installInto(root, 'claude-code', 'full_pipeline');
    assert.strictEqual((fs.readFileSync(file, 'utf8').match(/sdd-bootstrap:start/g) || []).length, 1);
    fs.appendFileSync(file, '\nuser added\n');
    instructions.restoreOne(root, 'claude-code', 'direct');
    assert.match(fs.readFileSync(file, 'utf8'), /sdd-bootstrap:start/);
    instructions.restoreOne(root, 'claude-code', 'full_pipeline');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'my instructions\n\nuser added\n');
  });

  test('AC-13 damaged CLAUDE bootstrap and symlink target reject installation before mutation', () => {
    const root = repo(); init(root);
    const file = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(file, '<!-- sdd-bootstrap:start -->\nmissing close');
    assert.throws(() => instructions.installInto(root, 'claude-code', 'direct'), /damaged/);
    assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'commands', 'sdd-direct.md')), false);
    fs.unlinkSync(file);
    const outside = path.join(os.tmpdir(), `sdd-claude-outside-${process.pid}.md`);
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, file);
    assert.throws(() => instructions.installInto(root, 'claude-code', 'direct'), /unsafe target/);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
    assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'commands', 'sdd-direct.md')), false);
  });

  test('AC-18 tampered instruction record cannot restore an unexpected target', () => {
    const root = repo(); init(root);
    instructions.installInto(root, 'claude-code', 'direct');
    const settings = path.join(root, '.claude', 'settings.json');
    fs.writeFileSync(settings, 'user settings\n');
    const recordFile = path.join(root, '.sdd-dev', 'instructions', 'claude-code.json');
    const record = readJson(recordFile);
    record.files['.claude/settings.json'] = {
      existed: true, original_base64: Buffer.from('attacker replacement\n').toString('base64'), routes: ['direct'],
    };
    writeJson(recordFile, record);
    assert.throws(() => instructions.restoreOne(root, 'claude-code', 'direct'), /not owned/);
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), 'user settings\n');
  });

  test('AC-18 Claude settings parent symlink refuses install without writing outside repo', () => {
    const root = repo(); init(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-outside-'));
    fs.symlinkSync(outside, path.join(root, '.claude'));
    const result = cli(root, ['hook', 'install', '--platform', 'claude-code']);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(fs.readdirSync(outside).length, 0);
  });

  test('AC-18 hook commands shell-quote paths with spaces, apostrophes and substitutions', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdd shell ' $(printf BAD) `printf BAD` ")));
    spawnSync('git', ['init', '-q'], { cwd: root });
    init(root);
    const installed = cli(root, ['hook', 'install', '--platform', 'claude-code']);
    assert.strictEqual(installed.status, 0, `${installed.stdout}${installed.stderr}`);
    const doc = readJson(path.join(root, '.claude', 'settings.json'));
    const command = doc.hooks.PreToolUse[0].hooks[0].command;
    const parsed = spawnSync('sh', ['-c', `set -- ${command}; printf '%s' "$3"`], { encoding: 'utf8' });
    assert.strictEqual(parsed.status, 0, parsed.stderr);
    assert.strictEqual(parsed.stdout, path.join(root, '.sdd-dev', 'tool', 'integrations', 'claude-code', 'hook.js'));
  });

  test('AC-6 and AC-16 Stop is idle without a run, blocks twice on work, and ignores report rewrites', () => {
    const root = repo();
    const idle = runHook(root, { hook_event_name: 'Stop' });
    assert.strictEqual(idle.status, 0);
    assert.strictEqual(idle.stdout, '');
    const id = start(root);
    const next = cli(root, ['run', 'next', '--run', id, '--json']);
    assert.strictEqual(next.status, 0, `${next.stdout}${next.stderr}`);
    assert.strictEqual(JSON.parse(next.stdout).action, 'continue');
    const payload = { hook_event_name: 'Stop', session_id: 'session-a' };
    for (let i = 0; i < 2; i += 1) {
      const result = runHook(root, payload);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
    }
    fs.writeFileSync(path.join(root, '.sdd-dev', 'runs', id, 'report.md'), 'rewritten report\n');
    const third = runHook(root, payload);
    assert.strictEqual(third.status, 0);
    assert.strictEqual(third.stdout, '');
    assert.match(third.stderr, /no progress/);
  });

  test('AC-6 invalid evidence, expired evidence, and unbound review do not reset Stop progress', () => {
    const root = repo(); const id = start(root);
    const runDir = path.join(root, '.sdd-dev', 'runs', id);
    fs.mkdirSync(path.join(runDir, 'spec'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'spec', 'execution-spec.md'),
      '---\nartifact: execution-spec\nrevision: 1\n---\n\n<!-- sec:acceptance -->\n- id: AC-1\n  requirement: R-1\n');
    fs.mkdirSync(path.join(runDir, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'plan', 'plan.md'), '---\nartifact: plan\nrevision: 1\n---\n');
    const before = digestProgress(root, runDir);
    const evidenceDir = path.join(runDir, 'evidence', 'AC-1');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'output.txt'), 'claimed pass\n');
    writeJson(path.join(evidenceDir, 'meta.json'), { ac: 'AC-1', status: 'pass', finished_at: '2026-10-05T00:00:00Z' });
    const reviewDir = path.join(runDir, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'result-review-r1.md'),
      '---\nartifact: result-review\nrevision: 1\nverdict: READY\nreviewer_kind: human\n---\n');
    writeJson(path.join(reviewDir, 'prepare-r1.json'), { written_at: '2026-10-05T00:00:00Z' });
    fs.mkdirSync(path.join(runDir, 'approvals'), { recursive: true });
    writeJson(path.join(runDir, 'approvals', 'plan.json'), { fake: true, at: '2026-10-05T00:00:00Z' });
    assert.strictEqual(digestProgress(root, runDir), before);
    fs.writeFileSync(path.join(reviewDir, 'result-review-r1.md'),
      '---\nartifact: result-review\nrevision: 1\nverdict: READY\nreviewer_kind: human\nbinding_hash: sha256:expired\n---\n');
    writeJson(path.join(reviewDir, 'result-review-r1.binding.json'), { version: 1, workspaces: [], evidence: [] });
    assert.strictEqual(digestProgress(root, runDir), before);
    writeJson(path.join(evidenceDir, 'meta.json'), {
      ac: 'AC-1', status: 'pass', codebase_ref: { head: 'expired', worktree_hash: '' },
    });
    assert.strictEqual(digestProgress(root, runDir), before);
    writeJson(path.join(evidenceDir, 'meta.json'), {
      ac: 'AC-1', status: 'pass', codebase_ref: computeCodebase(root).codebase_ref,
      finished_at: '2026-10-05T00:00:00Z',
    });
    const valid = digestProgress(root, runDir);
    assert.notStrictEqual(valid, before);
    writeJson(path.join(evidenceDir, 'meta.json'), {
      ac: 'AC-1', status: 'pass', codebase_ref: computeCodebase(root).codebase_ref,
      finished_at: '2026-10-06T00:00:00Z',
    });
    assert.strictEqual(digestProgress(root, runDir), valid);
  });

  test('AC-6 only resolving a block changes the block portion of Stop progress', () => {
    const root = repo(); const id = start(root);
    const runDir = path.join(root, '.sdd-dev', 'runs', id);
    const manifestPath = path.join(runDir, 'manifest.json');
    const baseline = digestProgress(root, runDir);
    const manifest = readJson(manifestPath);
    manifest.blocks.push({ id: 'B-1', affected: ['T-1'], condition: 'waiting', at: '2026-10-05T00:00:00Z' });
    writeJson(manifestPath, manifest);
    assert.strictEqual(digestProgress(root, runDir), baseline);
    manifest.blocks[0].resolved_at = '2026-10-06T00:00:00Z';
    manifest.blocks[0].evidence = 'sha256:resolved';
    writeJson(manifestPath, manifest);
    assert.notStrictEqual(digestProgress(root, runDir), baseline);
  });

  test('AC-6 Stop refuses error turns and corrupt hook state', () => {
    const root = repo(); const id = start(root);
    const failed = runHook(root, { hook_event_name: 'Stop', status: 'error', session_id: 'session-a' });
    assert.strictEqual(failed.stdout, '');
    const completed = runHook(root, { hook_event_name: 'Stop', status: 'completed', session_id: 'session-a' });
    assert.strictEqual(JSON.parse(completed.stdout).decision, 'block');
    const file = path.join(root, '.sdd-dev', 'runs', id, 'hook', 'stop-state.json');
    fs.writeFileSync(file, '{"bad":{"fingerprint":"x","count":"0"}}');
    const corrupt = runHook(root, { hook_event_name: 'Stop', status: 'completed', session_id: 'session-a' });
    assert.strictEqual(corrupt.stdout, '');
    assert.match(corrupt.stderr, /cannot be trusted/);
  });

  test('AC-6 Stop allows a third completed turn after real progress and stops after two unchanged decisions', () => {
    const root = repo(); start(root);
    fs.mkdirSync(path.join(root, 'src'));
    const file = path.join(root, 'src', 'a.js');
    fs.writeFileSync(file, 'export const value = 0;\n');
    for (let count = 0; count < 3; count += 1) {
      if (count) fs.writeFileSync(file, `export const value = ${count};\n`);
      const result = runHook(root, { hook_event_name: 'Stop', status: 'completed', session_id: 'progress' });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(JSON.parse(result.stdout).decision, 'block', `progress at turn ${count}: ${result.stderr}`);
    }
    for (let count = 0; count < 2; count += 1) {
      const result = runHook(root, { hook_event_name: 'Stop', status: 'completed', session_id: 'unchanged' });
      assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
    }
    const stopped = runHook(root, { hook_event_name: 'Stop', status: 'completed', session_id: 'unchanged' });
    assert.strictEqual(stopped.stdout, '');
    assert.match(stopped.stderr, /no progress/);
    const aborted = runHook(root, { hook_event_name: 'Stop', status: 'aborted', session_id: 'progress' });
    assert.strictEqual(aborted.stdout, '');
    const failed = runHook(root, { hook_event_name: 'Stop', status: 'error', session_id: 'progress' });
    assert.strictEqual(failed.stdout, '');
  });

  test('AC-6 and AC-18 symlink hook state and corrupt run never trigger automatic continuation', () => {
    const root = repo(); const id = start(root);
    const state = path.join(root, '.sdd-dev', 'runs', id, 'hook', 'stop-state.json');
    fs.mkdirSync(path.dirname(state));
    const outside = path.join(os.tmpdir(), `sdd-hook-state-outside-${process.pid}.json`);
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, state);
    const result = runHook(root, { hook_event_name: 'Stop', session_id: 's' });
    assert.strictEqual(result.stdout, '');
    assert.match(result.stderr, /cannot be trusted/);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), '{}');
    fs.unlinkSync(state);
    const manifest = path.join(root, '.sdd-dev', 'runs', id, 'manifest.json');
    fs.writeFileSync(manifest, '{broken');
    const invalid = runHook(root, { hook_event_name: 'Stop', session_id: 's' });
    assert.strictEqual(invalid.stdout, '');
    assert.match(invalid.stderr, /could not be checked/);
  });
};
