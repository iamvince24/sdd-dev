#!/usr/bin/env node
'use strict';

// 用法：node pipeline-guard.js <project-dir>
//
// 唯讀檢查（仿 gate-guard.js 的角色）：這個專案有沒有選
// references/strict-commit-pipeline.md 定義的「嚴格 per-commit pipeline 模式」；
// 選了的話，「目前排到的下一個 commit」狀態是不是 verifier_confirmed
// （唯一允許執行 git commit 的狀態）。被 pipeline-commit-hook.js 的
// commit 分支 spawn 呼叫，也可以手動跑排查。
//
// 狀態記在 notes.md 的「Commit Pipeline 狀態」區塊（不是 02-tasks.md），
// 因為 notes.md 從來不被任何 G1/G2/G3 指紋函式讀取（見 lib/fingerprint.js 的
// DOC_FINGERPRINTS），放這裡不會弄壞任何 Gate 核准指紋。
//
// exit code 沿用專案慣例（見 automation.md 開頭）：
//   0 = 通過（含「這個專案根本沒選嚴格模式」）；1 = 真的有 blocker；
//   3 = 結構／用法錯誤。**絕不用 2** —— 那是 PreToolUse 的阻擋語意。
//
// 已知限制：這支腳本不比對 git staged diff 內容是否真的對應「目前列」宣告的任務，
// 只看狀態欄本身——嚴格模式本來就是依序、不平行執行，這個簡化是刻意接受的。
// 也不跨檔案比對 notes.md 的 Commit 編號是否跟 02-tasks.md「建議 Commit 規劃」表一致，
// 那是 Claude 手動維護一致性的責任。

const path = require('path');
const { readFile, fileExists, extractSection, findTableByHeader, rowsAsObjects } = require('./lib/md');

const projectDir = process.argv[2];
if (!projectDir) {
  console.error('用法：node pipeline-guard.js <project-dir>');
  process.exit(3);
}

const STATUS_COL = 'Pipeline 狀態';
const COMMIT_COL = 'Commit';

console.log(`Pipeline 檢查報告 — ${path.resolve(projectDir)}\n`);

const notesPath = path.join(projectDir, 'notes.md');
if (!fileExists(notesPath)) {
  console.log('… 找不到 notes.md，視為未選嚴格模式，放行。');
  process.exit(0);
}

const notes = readFile(notesPath);
const section = extractSection(notes, /^Commit Pipeline 狀態$/);
if (!section) {
  console.log('… notes.md 沒有「Commit Pipeline 狀態」區塊，此專案未選嚴格模式，放行。');
  process.exit(0);
}

if (!/\*\*模式\*\*[:：]\s*`?strict-commit-pipeline`?/.test(section)) {
  console.log('… 找到「Commit Pipeline 狀態」區塊，但沒有宣告 `strict-commit-pipeline` 模式，放行。');
  process.exit(0);
}

const table = findTableByHeader(section, STATUS_COL);
if (table.headers.length === 0) {
  console.log(
    `✗ 已宣告 strict-commit-pipeline，但找不到含「${STATUS_COL}」欄的表格 — ` +
      '表頭被改名，或這個區塊還沒補上表格，這是結構問題，不是 Gate 判定。'
  );
  process.exit(3);
}

const rows = rowsAsObjects(table).filter((r) => (r[COMMIT_COL] || '').trim());
const current = rows.find((r) => (r[STATUS_COL] || '').trim() !== 'committed');

if (!current) {
  console.log('… 所有列出的 commit 都已 committed（或表格是空的），放行。');
  process.exit(0);
}

const status = (current[STATUS_COL] || '').trim() || '(空白)';
console.log(`目前排到 commit ${current[COMMIT_COL]}，Pipeline 狀態：${status}`);

if (status === 'verifier_confirmed') {
  console.log('✓ 狀態是 verifier_confirmed，可以 commit。');
  process.exit(0);
}

console.log(
  `✗ 尚未達到 verifier_confirmed（目前：${status}）— 在 verifier 回 CONFIRMED 並把這一列的 ` +
    'Pipeline 狀態改成 verifier_confirmed 之前，不得執行 git commit。'
);
console.log('\n結論：這個 commit 尚不能視為已通過嚴格 pipeline 驗證。');
process.exit(1);
