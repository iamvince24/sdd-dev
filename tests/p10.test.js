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
  test('AC-P10-1 supported platforms wrap one rule and keep the same rule hash', () => {
    assert.deepStrictEqual(instructions.PLATFORMS, ['claude-code', 'codex']);
    const rendered = instructions.PLATFORMS.map((platform) => instructions.render(platform, 'direct'));
    const rules = rendered.map((item) => instructions.extractRule(item.text));
    assert(rules.every(Boolean));
    const hashes = rules.map((item) => contentHash(Buffer.from(item.rule, 'utf8')));
    assert.deepStrictEqual(hashes, rendered.map(() => rendered[0].hash));
    assert.deepStrictEqual(rules.map((item) => item.rule), rendered.map(() => rendered[0].rule));
    assert.strictEqual(new Set(rendered.map((item) => item.text)).size, instructions.PLATFORMS.length);
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
    const sources = [
      ...instructions.ROUTES.map((route) => fs.readFileSync(path.join(TOOL_ROOT, 'templates', 'routes', `${route}.md`), 'utf8')),
      ...['scout', 'planner', 'plan-reviewer', 'executor', 'security-reviewer', 'verifier'].map((role) => (
        fs.readFileSync(path.join(TOOL_ROOT, 'templates', 'roles', `${role}.md`), 'utf8')
      )),
    ];
    const rendered = [];
    for (const route of instructions.ROUTES) {
      for (const platform of instructions.PLATFORMS) rendered.push(instructions.render(platform, route).text);
    }
    for (const text of [...sources, ...rendered]) assert.deepStrictEqual(instructions.modelNameHits(text, names), []);
  });

  test('AC-P10-3 install then uninstall restores an existing AGENTS.md and leaves other rules untouched', () => {
    const repo = tmpRepo();
    installTool(repo);
    const agents = Buffer.from('既有規則\n不要動這行');
    const own = Buffer.from('keep these instructions\n');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), agents);
    fs.mkdirSync(path.join(repo, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'commands', 'own.md'), own);

    const installed = sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'codex']);
    assert.strictEqual(installed.status, 0, output(installed));
    assert.notDeepStrictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md')), agents);
    const claude = sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'claude-code']);
    assert.strictEqual(claude.status, 0, output(claude));
    assert.deepStrictEqual(fs.readFileSync(path.join(repo, '.claude', 'commands', 'own.md')), own);
    assert(fs.existsSync(path.join(repo, '.claude', 'commands', 'sdd-direct.md')));

    fs.appendFileSync(path.join(repo, 'AGENTS.md'), '使用者後加\n');
    const again = sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'codex']);
    assert.strictEqual(again.status, 0, output(again));
    assert.match(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), /使用者後加/);
    assert.strictEqual(sdd(['instructions', 'uninstall', '--repo', repo, '--route', 'direct', '--platform', 'codex']).status, 0);
    assert.strictEqual(sdd(['instructions', 'uninstall', '--repo', repo, '--route', 'direct', '--platform', 'claude-code']).status, 0);
    assert.deepStrictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md')), agents);
    assert.deepStrictEqual(fs.readFileSync(path.join(repo, '.claude', 'commands', 'own.md')), own);
    assert(!fs.existsSync(path.join(repo, '.claude', 'commands', 'sdd-direct.md')));
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
    const filled = instructions.render('codex', 'direct', {
      matrix: { cells: { codex: { direct: true } } },
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
    const rendered = sdd(['instructions', 'render', '--route', 'sideways', '--platform', 'codex']);
    assert.strictEqual(rendered.status, 3, output(rendered));
    for (const route of ['full_pipeline', 'selected_advisors']) {
      const claude = instructions.render('claude-code', route);
      const codex = instructions.render('codex', route);
      assert.strictEqual(claude.hash, codex.hash);
      for (const renderedRoute of [claude, codex]) {
        assert.strictEqual(renderedRoute.verified, false);
        assert.match(renderedRoute.text, /verified: false/);
        assert.doesNotMatch(renderedRoute.text, /verified: true/);
      }
    }
    const repo = tmpRepo();
    const installed = sdd(['instructions', 'install', '--repo', repo, '--route', 'direct', '--platform', 'codex']);
    assert.strictEqual(installed.status, 1, output(installed));
    assert(!fs.existsSync(path.join(repo, 'AGENTS.md')));
  });
};
