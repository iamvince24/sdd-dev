'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateRepoId, validateItem } = require('../lib/resolver');
const { manifest, copyTree } = require('../lib/migration');
const { commandTargets, repoRelative } = require('../lib/hook');
const { removeOurs, ours } = require('../integrations/claude-code/settings');
const { listActiveProjects } = require('../scripts/lib/project-detect');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed += 1; }
  catch (error) { console.error(`✗ ${name}\n${error.stack}`); process.exitCode = 1; }
}

test('repo ids and nested item keys are stable', () => {
  assert.strictEqual(validateRepoId('sample.Web'), 'sample.Web');
  assert.strictEqual(validateItem('release-1/範例 項目'), 'release-1/範例 項目');
  assert.throws(() => validateItem('../escape'));
  assert.throws(() => validateRepoId('../escape'));
});

test('copy manifest preserves Unicode paths and content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devplan-test-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, 'active', 'v1', '項目'), { recursive: true });
  fs.writeFileSync(path.join(source, 'active', 'v1', '項目', '00-spec.md'), 'intent\n');
  copyTree(path.join(source, 'active'), path.join(target, 'active'));
  assert.deepStrictEqual(manifest(target), manifest(source));
});

test('active item discovery supports direct and nested release layouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devplan-active-'));
  fs.mkdirSync(path.join(root, 'direct-item'), { recursive: true });
  fs.mkdirSync(path.join(root, 'release-1', '巢狀項目'), { recursive: true });
  fs.writeFileSync(path.join(root, 'direct-item', '00-spec.md'), '# spec\n');
  fs.writeFileSync(path.join(root, 'release-1', '巢狀項目', '00-spec.md'), '# spec\n');
  assert.deepStrictEqual(listActiveProjects(root).sort(), ['direct-item', 'release-1/巢狀項目']);
});

test('manifest excludes operating-system metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devplan-meta-'));
  fs.mkdirSync(path.join(root, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'refs', '.DS_Store'), 'metadata');
  fs.writeFileSync(path.join(root, 'refs', 'guide.md'), 'guide');
  assert.deepStrictEqual(manifest(root).map((row) => row.path), ['refs/guide.md']);
});

test('repo-relative targets cannot escape their repository', () => {
  assert.strictEqual(repoRelative('src/a.js', '/tmp/example repo'), 'src/a.js');
  assert.strictEqual(repoRelative('../outside.js', '/tmp/example repo'), null);
});

test('bash target parsing ignores read-only commands', () => {
  assert.deepStrictEqual(commandTargets('sed -n 1,20p src/a.js'), []);
  assert.deepStrictEqual(commandTargets("sed -i '' s/a/b/ src/a.js"), ['s/a/b/', 'src/a.js']);
});

test('Claude settings removal preserves unrelated hooks', () => {
  const settings = { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'custom-hook' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ../devplan-v2/bin/devplan.js pipeline-hook' }] },
  ] } };
  assert(ours('node ../devplan-v2/bin/devplan.js hook'));
  const cleaned = removeOurs(settings);
  assert.strictEqual(cleaned.hooks.PreToolUse.length, 1);
  assert.strictEqual(cleaned.hooks.PreToolUse[0].hooks[0].command, 'custom-hook');
});

function privacyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devplan-privacy-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), '/state/\n/devplan.local.json\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Generic tool\n');
  return root;
}

function runPrivacy(root) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'privacy-check.js'), root], {
    encoding: 'utf8',
  });
}

test('privacy check ignores local state and scans private markers', () => {
  const root = privacyFixture();
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'private-spec.md'), 'private material\n');
  fs.writeFileSync(path.join(root, 'devplan.local.json'), JSON.stringify({
    privacy: { privateMarkers: ['ExamplePrivateProduct'] },
    projects: {},
  }));
  assert.strictEqual(runPrivacy(root).status, 0);
  fs.writeFileSync(path.join(root, 'README.md'), '# ExamplePrivateProduct\n');
  const result = runPrivacy(root);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /matches a private marker/);
  assert(!result.stdout.includes('ExamplePrivateProduct'));
});

test('privacy check rejects NUL bytes in public candidates', () => {
  const root = privacyFixture();
  fs.writeFileSync(path.join(root, 'public.bin'), Buffer.from([0x61, 0x00, 0x62]));
  const result = runPrivacy(root);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /contains NUL bytes/);
});

test('privacy check rejects force-added local state', () => {
  const root = privacyFixture();
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'private-spec.md'), 'private material\n');
  spawnSync('git', ['add', '-f', 'state/private-spec.md'], { cwd: root });
  const result = runPrivacy(root);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /local\/private artifact is tracked/);
});

if (!process.exitCode) console.log(`\n${passed} tests passed.`);
