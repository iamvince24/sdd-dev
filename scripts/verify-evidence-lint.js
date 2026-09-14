#!/usr/bin/env node
'use strict';

// 用法：node scripts/verify-evidence-lint.js <project-dir>
// 例如：node ../../scripts/verify-evidence-lint.js .
//
// 對應優化 #4：03-verify.md 的「證據」欄不接受敘述性、無法離線重現的句子。
// 這支腳本不判斷驗證邏輯對不對，只挑出「看起來像沒有真的留證據」的列。
//
// AF-4：證據看不出可重現型態的列，以前只給警告 —— 而警告可以被忽略，狀態不行。
// 現在一律判為 NOT-PROVEN 並計入 blocker；已經誠實標成 NOT-PROVEN 的列則通過檢查，
// 但會列進「歸檔前必須處理」，因為 NOT-PROVEN 不得進 done/。

// AF-A2：spec 升版之後，03-verify.md 裡已經填好的列還算不算數？README 的失效鏈表說不算，
// 但機器看不出來 —— 因為那些列沒有記錄「我是對著哪一版 spec 驗的」。
// 表上有「驗證時 spec 指紋」欄時，指紋對不上的列一律判為 STALE（要重驗），計入 blocker。

const path = require('path');
const { readFile, fileExists, extractSection, findTableByHeader, rowsAsObjects } = require('./lib/md');
const { fingerprintFor, extractFingerprint } = require('./lib/fingerprint');
const { assertSchema } = require('./schema-lint');

const projectDir = process.argv[2] || '.';
const verifyPath = path.join(projectDir, '03-verify.md');

if (!fileExists(verifyPath)) {
  console.error(`✗ 找不到 ${verifyPath}`);
  process.exit(3);
}

assertSchema(projectDir, '03-verify.md');

const content = readFile(verifyPath);
const section = extractSection(content, /^逐條 AC 結果$/) || content;
// 這個 section 底下不只一張表（前面還有「可以/不可以」對照表），要挑表頭真的是 AC 結果的那張。
const acTable = findTableByHeader(section, 'AC');
const rows = rowsAsObjects(acTable).filter((r) => (r['AC'] || '').trim());

// ---------- 指紋欄（只在表上真的有這一欄時才檢查，舊項目不受影響）----------
const SPEC_FP_COL = '驗證時 spec 指紋';
const PLAN_FP_COL = '驗證時 plan 指紋';
const hasSpecFpCol = acTable.headers.includes(SPEC_FP_COL);

function currentFingerprint(file) {
  const p = path.join(projectDir, file);
  return fileExists(p) ? fingerprintFor(file, readFile(p)) : null;
}
const currentSpecFp = hasSpecFpCol ? currentFingerprint('00-spec.md') : null;

// 常見的「敘述性、無法重現」句型
const VAGUE_PATTERNS = [
  /目視確認/,
  /看起來(正常|沒問題|OK)/i,
  /畫面正確/,
  /測過了?，?沒問題/,
  /跟(計劃|規格)一致/,
  /應該(沒問題|可以|OK)/i,
  /^ok$/i,
  /^沒問題$/,
];

// 能被離線重現的證據型態
const EVIDENCE_PATTERNS = [
  /refs\/evidence\//,
  /\b[0-9a-f]{7,40}\b/i, // commit hash
  /[.\w/-]+\.\w+:\d+/, // file:line
  /```/, // 貼上的輸出區塊
  /"[^"]+"\s*:/, // 貼上的 JSON 片段，例如 "sort": 12
  /\$\s?\S+/, // 貼指令
];

const NON_EVIDENCE_REQUIRED_STATUS = new Set(['', 'PENDING']);

let hasBlocker = false;
const notProven = []; // 已誠實標為 NOT-PROVEN 的列：不算 blocker，但不得進 done/
const lines = [];
function fail(msg) { lines.push(`✗ ${msg}`); hasBlocker = true; }
function warn(msg) { lines.push(`⚠ ${msg}`); }
function pass(msg) { lines.push(`✓ ${msg}`); }

if (rows.length === 0) {
  console.log('03-verify.md 目前沒有任何 AC 列（可能還是模板狀態），無需檢查。');
  process.exit(0);
}

for (const r of rows) {
  const ac = r['AC'];
  const status = (r['狀態'] || '').trim().toUpperCase();
  const evidence = (r['證據'] || '').trim();
  const isDeviation = /^N\/A/i.test(status);

  if (isDeviation) {
    pass(`${ac}：狀態為偏離登記（N/A），不需要證據`);
    continue;
  }
  if (NON_EVIDENCE_REQUIRED_STATUS.has(status)) {
    warn(`${ac}：狀態還是 PENDING/空白，尚未驗證`);
    continue;
  }
  // 指紋比對排在證據檢查前面：spec 已經改過的話，這列證據合不合格都要重驗。
  if (hasSpecFpCol && currentSpecFp) {
    const recorded = extractFingerprint(r[SPEC_FP_COL], 'spec');
    if (!recorded) {
      fail(`${ac}：狀態已填為 ${status}，但沒記錄驗證當下的 spec 指紋 — 無法判斷 spec 升版後這列還算不算數`);
      continue;
    }
    if (recorded !== currentSpecFp) {
      fail(
        `${ac}：STALE — 這列是對著 ${recorded} 驗的，00-spec.md 目前是 ${currentSpecFp}，` +
          '需求已經改過，這列要重驗'
      );
      continue;
    }
  }
  if (status === 'NOT-PROVEN') {
    notProven.push(ac);
    pass(`${ac}：狀態已誠實標為 NOT-PROVEN —— 不要求可重現證據，但歸檔前必須處理`);
    continue;
  }
  if (!evidence) {
    fail(`${ac}：狀態已填為 ${status}，但「證據」欄是空的`);
    continue;
  }
  const vague = VAGUE_PATTERNS.find((re) => re.test(evidence));
  if (vague) {
    fail(`${ac}：證據疑似敘述性、無法離線重現 — 「${evidence}」`);
    continue;
  }
  const hasRealEvidence = EVIDENCE_PATTERNS.some((re) => re.test(evidence));
  if (!hasRealEvidence) {
    fail(
      `${ac}：證據看不出可重現的型態（file:line／commit hash／refs/evidence 路徑／貼上的輸出），` +
        `此列判為 NOT-PROVEN，狀態 ${status} 不成立 — 「${evidence}」`
    );
    continue;
  }
  pass(`${ac}：證據型態合格`);
}

// ---------- 回歸風險表的 STALE 檢查 ----------
// 01-plan.md 升版會讓所有 INV-n 列失效（README 失效鏈表）。同樣只在欄位存在時檢查，
// 而且只查指紋 —— 這裡刻意不新增證據品質檢查，以免既有項目突然多出一批 blocker。
const invSection = extractSection(content, /^回歸風險驗證$/);
if (invSection) {
  const invTable = findTableByHeader(invSection, 'INV');
  if (invTable.headers.includes(PLAN_FP_COL)) {
    const currentPlanFp = currentFingerprint('01-plan.md');
    const invRows = rowsAsObjects(invTable).filter((r) => (r['INV'] || '').trim());
    for (const r of invRows) {
      const result = (r['結果'] || '').trim();
      if (!result) continue; // 還沒驗，不是 STALE
      const recorded = extractFingerprint(r[PLAN_FP_COL], 'plan');
      if (!currentPlanFp) continue;
      if (!recorded) {
        fail(`${r['INV']}：結果已填為 ${result}，但沒記錄驗證當下的 plan 指紋`);
      } else if (recorded !== currentPlanFp) {
        fail(
          `${r['INV']}：STALE — 這列是對著 ${recorded} 驗的，01-plan.md 目前是 ${currentPlanFp}，` +
            '不變量定義已經改過，這列要重驗'
        );
      }
    }
  }
}

console.log(`03-verify.md 證據檢查 — ${path.resolve(projectDir)}\n`);
console.log(lines.join('\n'));
if (hasBlocker) {
  console.log('\n結論：有 AC 的證據不合格（判為 NOT-PROVEN），G3 不能視為通過。');
} else if (notProven.length > 0) {
  console.log(
    `\n結論：證據型態都合格，但有 ${notProven.length} 條 NOT-PROVEN（${notProven.join(', ')}）。` +
      '\nG3 可以視為「已誠實回報」，但歸檔進 done/ 之前每一條都要轉成 PASS／FAIL／BLOCKED 或登記成 DEV-n 偏離。'
  );
} else {
  console.log('\n結論：沒有找到不合格的證據列（⚠ 的項目仍建議人工確認）。');
}

process.exit(hasBlocker ? 1 : 0);
