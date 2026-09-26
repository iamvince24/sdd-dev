'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOL_ROOT } = require('../lib/tool');
const { contentHash } = require('../lib/hash');
const instructions = require('../lib/instructions');

const BIN = path.join(TOOL_ROOT, 'bin', 'sdd.js');

function sdd(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function tmpRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p10-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function installTool(repo) {
  const result = sdd(['init', '--repo', repo, '--mode', 'repo-local', '--tracking', 'ignore']);
  assert.strictEqual(result.status, 0, output(result));
}

module.exports = function p10Tests(test) {
  test('AC-P10-1 three platforms wrap one rule and keep the same rule hash', () => {
    const rendered = instructions.PLATFORMS.map((platform) => instructions.render(platform, 'direct'));
    const rules = rendered.map((item) => instructions.extractRule(item.text));
    assert(rules.every(Boolean));
    const hashes = rules.map((item) => contentHash(Buffer.from(item.rule, 'utf8')));
    assert.deepStrictEqual(hashes, [rendered[0].hash, rendered[0].hash, rendered[0].hash]);
    assert.deepStrictEqual(rules.map((item) => item.rule), [rendered[0].rule, rendered[0].rule, rendered[0].rule]);
    assert.strictEqual(new Set(rendered.map((item) => item.text)).size, 3);
    for (const item of rendered) {
      const extracted = instructions.extractRule(item.text);
      assert.strictEqual(extracted.hash, item.hash);
      assert.notStrictEqual(item.text, item.rule);
    }
  });

  test('AC-P10-2 rendered instructions and the direct source miss every banned model name', () => {
    const names = instructions.loadModelNames();
    assert(names.length > 0);
    assert.deepStrictEqual(instructions.modelNameHits(`use ${names[0]} here`, names), [names[0]]);
    const files = [
      fs.readFileSync(path.join(TOOL_ROOT, 'templates', 'routes', 'direct.md'), 'utf8'),
      ...instructions.PLATFORMS.map((platform) => instructions.render(platform, 'direct').text),
    ];
    for (const text of files) assert.deepStrictEqual(instructions.modelNameHits(text, names), []);
  });

  test('AC-P10-3 install then uninstall restores an existing AGENTS.md and leaves other rules untouched', () => {
    const repo = tmpRepo();
    installTool(repo);
    const agents = Buffer.from('既有規則\n不要動這行');
    const own = Buffer.from('---\ndescription: keep\n---\n\nstay\n');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), agents);
    fs.mkdirSync(path.join(repo, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cursor', 'rules', 'own.mdc'), own);

    const installed = sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'codex']);
    assert.strictEqual(installed.status, 0, output(installed));
    assert.notDeepStrictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md')), agents);
    const cursor = sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'cursor']);
    assert.strictEqual(cursor.status, 0, output(cursor));
    assert.deepStrictEqual(fs.readFileSync(path.join(repo, '.cursor', 'rules', 'own.mdc')), own);
    assert(fs.existsSync(path.join(repo, '.cursor', 'rules', 'sdd-direct.mdc')));

    fs.appendFileSync(path.join(repo, 'AGENTS.md'), '使用者後加\n');
    const again = sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'codex']);
    assert.strictEqual(again.status, 0, output(again));
    assert.match(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), /使用者後加/);
    assert.strictEqual(sdd(['instructions', 'uninstall', '--repo', repo, '--route', 'direct', '--platform', 'codex']).status, 0);
    assert.strictEqual(sdd(['instructions', 'uninstall', '--repo', repo, '--route', 'direct', '--platform', 'cursor']).status, 0);
    assert.deepStrictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md')), agents);
    assert.deepStrictEqual(fs.readFileSync(path.join(repo, '.cursor', 'rules', 'own.mdc')), own);
    assert(!fs.existsSync(path.join(repo, '.cursor', 'rules', 'sdd-direct.mdc')));
  });

  test('AC-P10-4 an unfilled capability cell is rendered verified false', () => {
    const matrix = instructions.loadCapabilities();
    for (const platform of instructions.PLATFORMS) {
      assert.notStrictEqual(matrix.cells[platform] && matrix.cells[platform].direct, true);
      const rendered = instructions.render(platform, 'direct');
      assert.strictEqual(rendered.verified, false);
      assert.match(rendered.text, /verified: false/);
      assert.doesNotMatch(rendered.text, /verified: true/);
    }
    const filled = instructions.render('cursor', 'direct', {
      matrix: { cells: { cursor: { direct: true } } },
    });
    assert.strictEqual(filled.verified, true);
    assert.match(filled.text, /verified: true/);
  });

  test('sdd uninstall restores instruction files and a purge preview does not', () => {
    const repo = tmpRepo();
    installTool(repo);
    const agents = Buffer.from('keep-me\n');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), agents);
    assert.strictEqual(sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'codex']).status, 0);
    const preview = sdd(['uninstall', '--repo', repo, '--purge']);
    assert.strictEqual(preview.status, 1, output(preview));
    assert.notDeepStrictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md')), agents);
    assert(fs.existsSync(path.join(repo, '.sdd-dev')));

    const removed = sdd(['uninstall', '--repo', repo]);
    assert.strictEqual(removed.status, 0, output(removed));
    assert.match(removed.stdout, /restored AGENTS.md/);
    assert.deepStrictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md')), agents);
    assert(!fs.existsSync(path.join(repo, '.sdd-dev', 'tool')));
  });

  test('instructions reject an unknown route and a repo without init', () => {
    const rendered = sdd(['instructions', 'render', '--route', 'full_pipeline', '--platform', 'cursor']);
    assert.strictEqual(rendered.status, 3, output(rendered));
    const repo = tmpRepo();
    const installed = sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'cursor']);
    assert.strictEqual(installed.status, 1, output(installed));
    assert(!fs.existsSync(path.join(repo, '.cursor')));
  });
};
