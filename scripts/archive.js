#!/usr/bin/env node
'use strict';

// 用法：node scripts/archive.js <project-dir>
// 例如：node ../../scripts/archive.js .
//
// README〈完成後〉列了三條歸檔前檢查，但 `mv` 是人跑的 —— 三條散文沒有任何強制力。
// 這支把可機器驗證的部分驗完，全過才印出 mv 指令。**它不會自己搬檔案**（腳本唯讀）。
//
// exit code：0 = 可以歸檔；1 = 還有 blocker；3 = 結構／用法錯誤。

const path = require('path');
const {
  readFile,
  fileExists,
  extractSection,
  findTableByHeader,
  parseFirstTable,
  rowsAsObjects,
} = require('./lib/md');
const { assertSchema } = require('./schema-lint');

const projectDir = process.argv[2] || '.';
const verifyPath = path.join(projectDir, '03-verify.md');
const planPath = path.join(projectDir, '01-plan.md');
const specPath = path.join(projectDir, '00-spec.md');

if (!fileExists(verifyPath)) {
  console.error(`✗ 找不到 ${verifyPath} —— Tier L／M 的項目要有 03-verify.md 才談得上歸檔`);
  process.exit(3);
}
assertSchema(projectDir);

let hasBlocker = false;
const lines = [];
function pass(msg) { lines.push(`✓ ${msg}`); }
function fail(msg) { lines.push(`✗ ${msg}`); hasBlocker = true; }
function warn(msg) { lines.push(`⚠ ${msg}`); }

const verify = readFile(verifyPath);
const acRows = rowsAsObjects(findTableByHeader(extractSection(verify, /^逐條 AC 結果$/) || verify, 'AC')).filter(
  (r) => (r['AC'] || '').trim()
);

// verify 表不能只保留模板範例列：Spec 中每一條 AC 都必須明確出現在驗證表。
const spec = fileExists(specPath) ? readFile(specPath) : '';
const declaredACs = [...new Set([
  ...[...spec.matchAll(/^-\s*\[[ xX]\]\s*\*\*(R\d+\.\d+)\*\*/gm)].map((match) => match[1]),
  ...[...spec.matchAll(/^\|\s*(R\d+\.\d+)\s*\|/gm)].map((match) => match[1]),
])];
const verifiedACs = new Set(acRows.map((row) => (row['AC'] || '').replace(/`/g, '').trim()));
const missingACRows = declaredACs.filter((id) => !verifiedACs.has(id));
if (missingACRows.length > 0) fail(`03-verify.md 缺少 Spec AC 列：${missingACRows.join(', ')}`);
else if (declaredACs.length > 0) pass(`Spec 的每條 AC 都出現在驗證表（共 ${declaredACs.length} 條）`);

// ---------- 檢查 1：每條 AC 都有結果，且不得留 NOT-PROVEN ----------
const unfilled = acRows.filter((r) => !(r['狀態'] || '').trim() || /^PENDING$/i.test((r['狀態'] || '').trim()));
if (acRows.length === 0) {
  fail('03-verify.md 沒有任何 AC 列');
} else if (unfilled.length > 0) {
  fail(`還有 AC 沒有結果（PENDING／空白）：${unfilled.map((r) => r['AC']).join(', ')}`);
} else {
  pass('每條 AC 都有結果');
}

const notProven = acRows.filter((r) => /NOT-PROVEN/i.test(r['狀態'] || ''));
if (notProven.length > 0) {
  fail(
    `NOT-PROVEN 不得進 done/：${notProven.map((r) => r['AC']).join(', ')}` +
      ' —— 補到可重現的證據轉 PASS，或改判 FAIL／BLOCKED，或登記成 DEV-n 偏離'
  );
} else {
  pass('沒有殘留的 NOT-PROVEN');
}

// ---------- 檢查 2：沒通過的 AC 要有落點 ----------
// 「未達成的必須出現在偏離登記表或 follow-up 節，不能留空白」（README〈完成後〉）。
const followupRows = rowsAsObjects(parseFirstTable(extractSection(verify, /^未通過與 Follow-up$/) || '')).filter(
  (r) => (r['AC'] || '').trim()
);
const devCell = fileExists(specPath)
  ? rowsAsObjects(parseFirstTable(extractSection(spec, /^6\. 規格偏離登記$/) || ''))
      .map((r) => `${r['#'] || ''} ${r['影響 AC'] || ''}`)
      .join(' ')
  : '';
const notPassed = acRows.filter((r) => !/^(PASS|N\/A)/i.test((r['狀態'] || '').trim()));
const homeless = notPassed.filter((r) => {
  const ac = (r['AC'] || '').replace(/`/g, '').trim();
  const inFollowup = followupRows.some((f) => (f['AC'] || '').includes(ac));
  const inDev = devCell.includes(ac);
  return !inFollowup && !inDev;
});
if (notPassed.length === 0) {
  pass('每條 AC 都是 PASS 或 N/A（偏離）');
} else if (homeless.length > 0) {
  fail(
    `沒通過的 AC 既不在「未通過與 Follow-up」表、也不在規格偏離登記：${homeless
      .map((r) => r['AC'])
      .join(', ')}`
  );
} else {
  pass(`沒通過的 AC（${notPassed.map((r) => r['AC']).join(', ')}）都有落點`);
}

// ---------- 檢查 3：每條 INV-n 都要有結果 ----------
const invSection = extractSection(verify, /^回歸風險驗證$/);
const invRows = rowsAsObjects(findTableByHeader(invSection || '', 'INV')).filter((r) => (r['INV'] || '').trim());
const declaredInvs = fileExists(planPath)
  ? (extractSection(readFile(planPath), /^6\. 不變量/) || '').match(/INV-\d+/g) || []
  : [];
const uniqueDeclared = [...new Set(declaredInvs)];
// PENDING 不算結果 —— 它是「還沒驗」，跟空白一樣。
const hasResult = (cell) => {
  const v = (cell || '').trim();
  return v !== '' && !/^PENDING$/i.test(v);
};
const missingInv = uniqueDeclared.filter((id) => !invRows.some((r) => r['INV'].includes(id) && hasResult(r['結果'])));
if (uniqueDeclared.length === 0) {
  warn('01-plan.md 沒有宣告任何 INV-n（Tier S／M 可能本來就沒有 plan）');
} else if (missingInv.length > 0) {
  fail(`01-plan.md 宣告的不變量在回歸風險表沒有結果：${missingInv.join(', ')}`);
} else {
  pass(`每條 INV-n 都有結果（共 ${uniqueDeclared.length} 條）`);
}

// ---------- 檢查 4：repo 陷阱有沒有搬出去 ----------
// 「是不是陷阱」機器判斷不了，所以這一項只提醒，不擋 —— 但一定要講，
// 不然它就是那種「跟著項目一起進 done/ 被埋掉」的知識。
const notesPath = path.join(projectDir, 'notes.md');
const readRows = fileExists(notesPath)
  ? rowsAsObjects(parseFirstTable(extractSection(readFile(notesPath), /^讀過的檔案/) || '')).filter(
      (r) => (r['檔案'] || '').trim()
    )
  : [];
if (readRows.length > 0) {
  warn(
    `notes.md 讀過的檔案表有 ${readRows.length} 列 —— 歸檔前確認裡面「這個 repo 的陷阱」` +
      '已經搬進 ../../refs/codebase-gotchas.md（那是 repo 的知識，不是這個需求的知識）'
  );
}

console.log(`歸檔前檢查 — ${path.resolve(projectDir)}\n`);
console.log(lines.join('\n'));
if (hasBlocker) {
  console.log('\n結論：還不能歸檔，先處理上面標 ✗ 的項目。');
  process.exit(1);
}
const absoluteProject = path.resolve(projectDir);
const segments = absoluteProject.split(path.sep);
const activeIndex = segments.lastIndexOf('active');
const itemKey = activeIndex >= 0 ? segments.slice(activeIndex + 1).join('/') : path.basename(absoluteProject);
console.log('\n結論：機器可驗證的部分都通過，可以歸檔：\n');
console.log(`  ${itemKey} → done/${itemKey}`);
process.exit(0);
