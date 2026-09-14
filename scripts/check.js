#!/usr/bin/env node
'use strict';

// 用法：node scripts/check.js <project-dir> [G1|G2|G3|archive]
// 例如：node ../../scripts/check.js . G2
//
// 其餘腳本各自負責一件事，代價是「什麼時候該跑哪幾支」變成又一個要記得的事。
// 這支照 Gate 自動挑該跑的組合，彙總成一份報告，少一個記憶點。
//
// exit code：0 = 全數通過；1 = 有 blocker；3 = 結構／用法錯誤（任何一支回 3）。

const path = require('path');
const { spawnSync } = require('child_process');
const { fileExists } = require('./lib/md');

const projectDir = process.argv[2] || '.';
const gate = (process.argv[3] || '').toUpperCase();

const PLANS = {
  G1: [['schema-lint.js'], ['coverage-lint.js'], ['gate-guard.js', 'G1']],
  G2: [['schema-lint.js'], ['coverage-lint.js'], ['gate-guard.js', 'G2']],
  G3: [['schema-lint.js'], ['verify-evidence-lint.js'], ['gate-guard.js', 'G3']],
  ARCHIVE: [['schema-lint.js'], ['verify-evidence-lint.js'], ['archive.js']],
  // 沒指定 Gate 時跑全部唯讀檢查，但不含 gate-guard（它需要知道問的是哪個 Gate）
  '': [['schema-lint.js'], ['coverage-lint.js'], ['verify-evidence-lint.js']],
};

// 每個 Gate 附帶產生對應的 HTML 報告（方便閱讀用，見 render-html.js）。
// G1→00-spec、G2→01-plan+02-tasks、G3→03-verify；不指定 Gate／archive 就全部產生。
const RENDER_ARG = { G1: 'G1', G2: 'G2', G3: 'G3', ARCHIVE: 'all', '': 'all' };

const plan = PLANS[gate === 'ARCHIVE' ? 'ARCHIVE' : gate];
if (!plan) {
  console.error('用法：node check.js <project-dir> [G1|G2|G3|archive]');
  process.exit(3);
}
if (!fileExists(projectDir)) {
  console.error(`✗ 找不到 ${projectDir}`);
  process.exit(3);
}

console.log(`綜合檢查 — ${path.resolve(projectDir)}${gate ? `（${gate}）` : '（未指定 Gate，跑全部唯讀檢查）'}\n`);

const results = [];
for (const [script, ...args] of plan) {
  const r = spawnSync('node', [path.join(__dirname, script), projectDir, ...args], { encoding: 'utf8' });
  const status = r.status === null ? 3 : r.status;
  results.push({ script, args, status });
  console.log(`${'─'.repeat(60)}\n▶ ${script}${args.length ? ' ' + args.join(' ') : ''}\n`);
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  console.log('');
}

// HTML 報告：純粹方便閱讀，跑在上面的彙總邏輯之外——刻意 fail-open，
// 渲染失敗不該讓一個原本會過的 Gate 被判失敗，所以它的 exit code 不計入 blocker／結構錯誤。
const renderArg = RENDER_ARG[gate === 'ARCHIVE' ? 'ARCHIVE' : gate];
let renderOk = true;
if (renderArg) {
  const r = spawnSync('node', [path.join(__dirname, 'render-html.js'), projectDir, renderArg], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  renderOk = r.status === 0;
}

console.log('─'.repeat(60));
console.log('\n總結：\n');
const label = { 0: '通過', 1: 'blocker', 3: '結構／用法錯誤' };
for (const r of results) {
  const mark = r.status === 0 ? '✓' : '✗';
  console.log(`${mark} ${r.script}${r.args.length ? ' ' + r.args.join(' ') : ''} — ${label[r.status] || `exit ${r.status}`}`);
}
console.log(renderOk ? '📄 render-html.js — HTML 報告已產生' : '⚠ render-html.js — HTML 報告產生失敗（不影響上面的 Gate 判定）');

if (results.some((r) => r.status === 3)) {
  console.log('\n先修文件結構 —— 結構對不上的時候，其他檢查的「通過」不算數。');
  process.exit(3);
}
if (results.some((r) => r.status !== 0)) {
  console.log('\n還有 blocker，這個 Gate 不能視為通過。');
  process.exit(1);
}
console.log('\n機器可驗證的部分全數通過。要不要核准仍然是人的判斷。');
process.exit(0);
