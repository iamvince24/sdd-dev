#!/usr/bin/env node
'use strict';

// 用法：node scripts/coverage-lint.js <project-dir>
// 例如：node ../../scripts/coverage-lint.js .   （在某個 active/<項目> 目錄下執行）
//
// 檢查對應優化 #1（R/AC/T 覆蓋率對帳自動化）與 #6（task 是否連結已知 gotcha）。
// 讀 00-spec.md 的 R / AC / [U][S][C] 標記 / 第 9 節問答狀態，
// 對照 02-tasks.md 的任務表，找出孤兒 R、孤兒 AC、孤兒任務、未轉正的 [C]、還 open 的 Q。
// 有任何一項阻擋 G1/G2 的問題時，exit code 為 1。

const fs = require('fs');
const path = require('path');
const { readFile, fileExists, extractSection, parseFirstTable, rowsAsObjects, parseKeyValueTable } = require('./lib/md');
const { assertSchema } = require('./schema-lint');

const projectDir = process.argv[2] || '.';
const specPath = path.join(projectDir, '00-spec.md');
const tasksPath = path.join(projectDir, '02-tasks.md');
// 統一 CLI 會明確傳入 project-specific gotchas；fallback 支援任意 release/item 深度。
function stateRootFor(itemDir) {
  let current = path.resolve(itemDir);
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'active') return path.dirname(current);
    current = path.dirname(current);
  }
  return path.resolve(itemDir, '..', '..');
}
const gotchasPath = process.env.DEVPLAN_GOTCHAS_PATH || path.join(stateRootFor(projectDir), 'refs', 'codebase-gotchas.md');
const codebaseProfilePath = process.env.DEVPLAN_CODEBASE_PROFILE_PATH || path.join(stateRootFor(projectDir), 'refs', 'codebase-profile.json');

if (!fileExists(specPath) || !fileExists(tasksPath)) {
  console.error(`✗ 找不到 ${specPath} 或 ${tasksPath}`);
  process.exit(3); // 結構／用法錯誤一律 3，不用 2（2 在 PreToolUse 是「擋下」）
}

assertSchema(projectDir, '00-spec.md');
assertSchema(projectDir, '02-tasks.md');

const spec = readFile(specPath);
const tasksContent = readFile(tasksPath);

let hasBlocker = false;
const lines = [];
function pass(msg) { lines.push(`✓ ${msg}`); }
function fail(msg) { lines.push(`✗ ${msg}`); hasBlocker = true; }
function warn(msg) { lines.push(`⚠ ${msg}`); }

// ---------- 解析 00-spec.md 的 R / AC ----------
const reqSection = extractSection(spec, /^4\. 需求與驗收條件$/) || spec;
const reqBlocks = reqSection.split(/^### /m).slice(1);

const requirements = []; // { id, acs: [{ id, tag }] }
for (const block of reqBlocks) {
  const rIdMatch = block.match(/^(R\d+)\s*—/);
  if (!rIdMatch) continue; // 跳過「邊界條件 / 例外」這類非 R 的 ### 區塊
  const rId = rIdMatch[1];
  const acs = [];
  // 標記可以帶回指：`[U:Q3]` 代表「這條是使用者拍板的，原話在 Q3」。
  // 舊格式 `[U]` 仍然接受 —— 但那條線索一旦 [C] 轉正就斷了，只剩「某次對話裡講過」。
  const acLineRegex = /-\s*\[[ xX]\]\s*\*\*(R\d+\.\d+)\*\*[^\n]*?`(\[([USC])(?::(Q\d+))?\])`/g;
  let m;
  while ((m = acLineRegex.exec(block))) {
    acs.push({ id: m[1], tag: `[${m[3]}]`, source: m[3], backref: m[4] || null });
  }
  requirements.push({ id: rId, acs });
}
const allACs = requirements.flatMap((r) => r.acs);

// ---------- 解析第 9 節問答紀錄 ----------
const qaSection = extractSection(spec, /^9\. 問答紀錄$/);
const qaRows = qaSection ? rowsAsObjects(parseFirstTable(qaSection)) : [];
const openQs = qaRows.filter((r) => (r['狀態'] || '').trim() === 'open' && (r['#'] || '').trim());

// ---------- 解析 02-tasks.md 任務清單 ----------
const taskSection = extractSection(tasksContent, /^任務清單$/) || tasksContent;
const taskTable = parseFirstTable(taskSection);
const taskRows = rowsAsObjects(taskTable)
  // 模板留白的示範列（T1/T2 全是空的欄位）不當真資料
  .filter((r) => (r['任務'] || '').trim() !== '');

function extractACRefs(cell) {
  return (cell.match(/R\d+\.\d+/g) || []);
}

const acToTasks = new Map(); // AC id -> [task id]
const orphanTasks = [];
for (const t of taskRows) {
  const refs = extractACRefs(t['服務 AC'] || '');
  const taskId = t['#'] || '(未命名)';
  if (refs.length === 0) {
    orphanTasks.push(taskId);
  }
  for (const ref of refs) {
    if (!acToTasks.has(ref)) acToTasks.set(ref, []);
    acToTasks.get(ref).push(taskId);
  }
}

// ---------- 檢查 1：每條 R 至少有一條 AC ----------
const orphanRs = requirements.filter((r) => r.acs.length === 0).map((r) => r.id);
if (orphanRs.length === 0) pass('每條 R 至少有一條 AC');
else fail(`每條 R 至少有一條 AC — 沒有 AC 的需求：${orphanRs.join(', ')}`);

// ---------- 檢查 2：每條 AC 至少有一個 T ----------
const orphanACs = allACs.filter((ac) => !acToTasks.has(ac.id) || acToTasks.get(ac.id).length === 0).map((ac) => ac.id);
if (allACs.length === 0) warn('spec 裡目前沒有任何 AC，無法檢查覆蓋率（可能還是模板狀態）');
else if (orphanACs.length === 0) pass('每條 AC 至少有一個 T');
else fail(`每條 AC 至少有一個 T — 沒有任務對應的 AC：${orphanACs.join(', ')}`);

// ---------- 檢查 3：每個 T 至少回指一條 AC ----------
if (taskRows.length === 0) warn('02-tasks.md 裡目前沒有任何任務（可能還是模板狀態）');
else if (orphanTasks.length === 0) pass('每個 T 至少回指一條 AC');
else fail(`每個 T 至少回指一條 AC — 沒有回指 AC 的任務（範圍外）：${orphanTasks.join(', ')}`);

// ---------- 檢查 4：[C] 未轉正 ----------
const unconfirmed = allACs.filter((ac) => ac.tag === '[C]').map((ac) => ac.id);
if (unconfirmed.length === 0) pass('沒有殘留 [C]（Claude 推論未確認）的 AC');
else fail(`還有 [C] 未轉正，不得進 G1：${unconfirmed.join(', ')}`);

// ---------- 檢查 5：open 的 Q ----------
if (openQs.length === 0) pass('第 9 節問答紀錄沒有 open 的問題');
else fail(`還有 open 的問題，不得進 G1：${openQs.map((r) => r['#']).join(', ')}`);

// ---------- 檢查 5.5：[U] 的回指 ----------
// [C] 必須同時出現在第 9 節（decision-anchors.md），但轉正成 [U] 之後那條線就斷了：
// 「這條是使用者親口說的」只剩下當初那次對話知道。標成 [U:Q3] 才接得回問答紀錄。
const answeredQs = new Set(
  qaRows.filter((r) => /answered/i.test(r['狀態'] || '')).map((r) => (r['#'] || '').trim())
);
const userACs = allACs.filter((ac) => ac.source === 'U');
const badBackref = userACs.filter((ac) => ac.backref && !answeredQs.has(ac.backref));
const noBackref = userACs.filter((ac) => !ac.backref);
if (badBackref.length > 0) {
  fail(
    `有 AC 的來源回指找不到對應的 answered 問答：${badBackref
      .map((ac) => `${ac.id}→${ac.backref}`)
      .join(', ')}`
  );
} else if (userACs.length > 0 && noBackref.length === userACs.length) {
  warn(`${userACs.length} 條 [U] 都還是舊格式（沒有回指）—— 新寫的 AC 建議標成 [U:Q3] 指回問答紀錄`);
} else if (userACs.length > 0) {
  pass(`[U] 的回指都指得到 answered 的問答（${userACs.length - noBackref.length}/${userACs.length} 條有回指）`);
}

// ---------- 檢查 5.6：由檔案欄與 spec 狀態反推 Tier ----------
// Tier 是整套流程裡唯一有作弊誘因的欄位（標成 M 就跳過兩次獨立審查），卻沒有交叉檢查。
// 公開工具只內建不含 codebase 知識的判斷。專案路徑與子系統規則只能放在 ignored 的
// refs/codebase-profile.json；這裡只主張「至少」，不主張上限。
const TIER_ORDER = { S: 0, M: 1, L: 2 };
const taskFilePaths = taskRows
  .flatMap((t) => (t['檔案'] || '').split(/[、,]/))
  .map((value) => value.replace(/`/g, '').split(':')[0].trim())
  .filter(Boolean);
const machineTriggers = [];
if (unconfirmed.length > 0 || openQs.length > 0) machineTriggers.push('需求本身還不確定（殘留 [C] 或 open 的問題）');

if (fileExists(codebaseProfilePath)) {
  let profile;
  try {
    profile = JSON.parse(readFile(codebaseProfilePath));
  } catch (error) {
    console.error(`✗ codebase profile 不是有效 JSON：${codebaseProfilePath}（${error.message}）`);
    process.exit(3);
  }
  const rules = Array.isArray(profile.tierPathTriggers) ? profile.tierPathTriggers : [];
  for (const [ruleIndex, rule] of rules.entries()) {
    if (!rule || !Array.isArray(rule.groups) || rule.groups.length === 0 ||
        rule.groups.some((group) => !Array.isArray(group) || group.length === 0 || group.some((pattern) => typeof pattern !== 'string'))) {
      console.error(`✗ codebase profile 的 tierPathTriggers[${ruleIndex}] 結構無效：每條規則需要非空的 groups 字串陣列`);
      process.exit(3);
    }
    let matched;
    try {
      matched = rule.groups.every((group) =>
        group.some((pattern) => {
          const regex = new RegExp(pattern);
          return taskFilePaths.some((file) => regex.test(file));
        })
      );
    } catch (error) {
      console.error(`✗ codebase profile 的 tierPathTriggers[${ruleIndex}] 含無效 regex（${error.message}）`);
      process.exit(3);
    }
    if (matched) machineTriggers.push((rule.label || `本機路徑規則 ${ruleIndex + 1}`).trim());
  }
}
const inferredTier = machineTriggers.length >= 2 ? 'L' : machineTriggers.length === 1 ? 'M' : 'S';
const tierCell = parseKeyValueTable(spec)['Tier'] || '';
// 模板未填時整格是「S / M / L（判定理由寫一句）」，那不是判定結果，別拿它比對。
const declaredTierMatch = /S \/ M \/ L/.test(tierCell) ? null : tierCell.match(/[SML]/);
const declaredTier = declaredTierMatch ? declaredTierMatch[0] : null;
if (declaredTier && TIER_ORDER[declaredTier] < TIER_ORDER[inferredTier]) {
  warn(
    `00-spec.md 標的 Tier 是 ${declaredTier}，但機器看得到的觸發已經有 ${machineTriggers.length} 條` +
      `（${machineTriggers.join('；')}）—— 至少該是 ${inferredTier}。` +
      '其他無法由公開工具判斷的觸發（契約／信任邊界／重大決策）請自行確認'
  );
}

// ---------- 檢查 6（優化 #6）：任務是否命中已知 gotcha 卻沒填關聯欄 ----------
if (fileExists(gotchasPath)) {
  const gotchaRows = rowsAsObjects(parseFirstTable(readFile(gotchasPath)));
  for (const t of taskRows) {
    const taskFile = (t['檔案'] || '').trim();
    if (!taskFile) continue;
    const hitGotchas = gotchaRows.filter((g) => {
      const loc = (g['位置'] || '');
      // 位置欄可能同時列多個檔案，用逗號/頓號/反引號切開後個別比對
      return loc
        .split(/[、,]/)
        .map((s) => s.replace(/`/g, '').split(':')[0].trim())
        .some((p) => p && taskFile.includes(p));
    });
    if (hitGotchas.length > 0 && !(t['關聯 Gotcha'] || '').trim()) {
      warn(
        `任務 ${t['#']}（${taskFile}）命中已知陷阱 ${hitGotchas.map((g) => g['#']).join(', ')}，` +
          '但「關聯 Gotcha」欄空白 — 動手前請先重新確認該記錄是否還成立並填上編號'
      );
    }
  }
} else {
  warn(`找不到 ${gotchasPath}，略過 gotcha 連結檢查`);
}

// ---------- 輸出 ----------
console.log(`覆蓋率對帳報告 — ${path.resolve(projectDir)}\n`);
console.log(lines.join('\n'));
console.log('\n可貼進 02-tasks.md「覆蓋率對帳」表的摘要：\n');
console.log('| 檢查 | 結果 |');
console.log('| --- | --- |');
console.log(`| 每條 R 至少有一條 AC | ${orphanRs.length === 0 ? 'PASS' : 'FAIL: ' + orphanRs.join(', ')} |`);
console.log(`| 每條 AC 至少有一個 T | ${orphanACs.length === 0 ? 'PASS' : 'FAIL: ' + orphanACs.join(', ')} |`);
console.log(`| 每個 T 至少回指一條 AC | ${orphanTasks.length === 0 ? 'PASS' : 'FAIL: ' + orphanTasks.join(', ')} |`);
console.log(
  `| 孤兒項目 | ${
    orphanRs.length + orphanACs.length + orphanTasks.length === 0
      ? '無'
      : [...orphanRs, ...orphanACs, ...orphanTasks].join(', ')
  } |`
);

process.exit(hasBlocker ? 1 : 0);
