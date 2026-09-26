'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed += 1; }
  catch (error) { console.error(`✗ ${name}\n${error.stack}`); process.exitCode = 1; }
}

function privacyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-privacy-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), '/.sdd-dev/runs/\n/sdd-dev.local.json\n');
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
  fs.mkdirSync(path.join(root, '.sdd-dev', 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdd-dev', 'runs', 'r1', 'private-spec.md'), 'private material\n');
  fs.writeFileSync(path.join(root, 'sdd-dev.local.json'), JSON.stringify({
    privacy: { privateMarkers: ['ExamplePrivateProduct'] },
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
  fs.mkdirSync(path.join(root, '.sdd-dev', 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdd-dev', 'runs', 'r1', 'private-spec.md'), 'private material\n');
  spawnSync('git', ['add', '-f', '.sdd-dev/runs/r1/private-spec.md'], { cwd: root });
  const result = runPrivacy(root);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /local\/private artifact is tracked/);
});

test('privacy check skips tracked files deleted from the working tree', () => {
  const root = privacyFixture();
  fs.writeFileSync(path.join(root, 'old.md'), 'old\n');
  spawnSync('git', ['add', 'old.md'], { cwd: root });
  fs.unlinkSync(path.join(root, 'old.md'));
  assert.strictEqual(runPrivacy(root).status, 0);
});

test('privacy check allows public URLs', () => {
  const root = privacyFixture();
  fs.writeFileSync(path.join(root, 'README.md'), '# Tool\n\nSee https://example.com/docs.\n');
  assert.strictEqual(runPrivacy(root).status, 0);
});

test('sdd without a command prints usage and exits 3', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sdd.js')], { encoding: 'utf8' });
  assert.strictEqual(result.status, 3);
  assert.match(result.stderr, /Usage: sdd/);
});

require('./install.test')(test);
require('./p2.test')(test);
require('./p3.test')(test);
require('./p4.test')(test);
require('./p5.test')(test);
require('./p10.test')(test);

if (!process.exitCode) console.log(`\n${passed} tests passed.`);
