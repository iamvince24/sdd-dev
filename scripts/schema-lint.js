#!/usr/bin/env node
'use strict';

// 用法：node scripts/schema-lint.js <project-dir>
// 例如：node ../../scripts/schema-lint.js .
//
// 其餘腳本都是「以表頭名稱取值」，找不到表頭時回空表 —— 於是改掉一個表頭文字
// （或改掉表格所在的標題），對應的檢查會**靜默失效**：輸出看起來一切通過，其實什麼都沒檢查。
// 這支負責把那種情況變成明確的錯誤。
//
// 它同時是其他腳本的開場自檢模組：require 進去呼叫 checkSchema()。
//
// exit code：0 = 結構齊全；3 = 結構／用法錯誤。
// **不使用 exit 2** —— 2 在 Claude Code 的 PreToolUse 語意裡是「真的擋下工具執行」，
// 兩套相反的語意共存是地雷，整個 devplan-v2 一律用 3 表示結構問題。

const path = require('path');
const { readFile, fileExists, requireTable, SchemaError } = require('./lib/md');

// 每一項是「這張表一定要在，而且一定要有這些欄位」。
// 只列機器真的會去讀的表與欄位 —— 列太多會變成另一種形式的規格重複。
const SCHEMA = {
  '00-spec.md': [
    { heading: null, headers: ['欄位', '內容'], ctx: 'metadata 表' },
    { heading: /^6\. 規格偏離登記$/, headers: ['#', '影響 AC'], ctx: '規格偏離登記' },
    { heading: /^9\. 問答紀錄$/, headers: ['#', '狀態', '問題'], ctx: '問答紀錄' },
    { heading: /^10\. 修訂紀錄$/, headers: ['版本'], ctx: 'spec 修訂紀錄' },
  ],
  '01-plan.md': [
    { heading: /^2\. 設計決策$/, headers: ['#', '服務哪些 AC'], ctx: '設計決策' },
    { heading: /^6\. 不變量/, headers: ['#', '起始條件', '可觀察結果', '失敗條件'], ctx: '不變量' },
    { heading: /^8\. 修訂紀錄$/, headers: ['版本'], ctx: 'plan 修訂紀錄' },
  ],
  '02-tasks.md': [
    {
      heading: /^任務清單$/,
      headers: ['#', '任務', '服務 AC', '檔案', '狀態'],
      ctx: '任務清單',
    },
    { heading: /^修訂紀錄$/, headers: ['版本'], ctx: 'tasks 修訂紀錄' },
  ],
  '03-verify.md': [
    { heading: /^逐條 AC 結果$/, headers: ['AC', '狀態', '證據'], ctx: '逐條 AC 結果' },
    { heading: /^回歸風險驗證$/, headers: ['INV', '結果', '證據'], ctx: '回歸風險驗證' },
  ],
  'notes.md': [
    { heading: /^Gate 狀態$/, headers: ['Gate', '狀態', '核准的版本'], ctx: 'Gate 狀態表' },
    {
      heading: /^獨立審查紀錄/,
      headers: ['日期', '角色', 'Verdict', '處置與理由'],
      ctx: '獨立審查紀錄表',
    },
  ],
};

// 回傳問題字串陣列（空陣列代表結構齊全）。
// 只檢查「存在的檔案」—— Tier S/M 本來就不會有四個檔都在，缺檔不是結構錯誤。
function checkSchema(projectDir, only) {
  const problems = [];
  const files = only ? [only] : Object.keys(SCHEMA);
  for (const file of files) {
    const p = path.join(projectDir, file);
    if (!fileExists(p)) continue;
    const content = readFile(p);
    for (const rule of SCHEMA[file]) {
      try {
        requireTable(content, rule);
      } catch (e) {
        if (e instanceof SchemaError || e.isSchemaError) problems.push(`${file}：${e.message}`);
        else throw e;
      }
    }
  }
  return problems;
}

// 給其他腳本開場呼叫：結構有問題就印出來並以 3 結束，不要帶著壞掉的解析繼續跑。
function assertSchema(projectDir, only) {
  const problems = checkSchema(projectDir, only);
  if (problems.length === 0) return;
  console.error('✗ 文件結構與腳本預期不符，檢查會靜默失效，先修結構再跑：\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(3);
}

module.exports = { checkSchema, assertSchema, SCHEMA };

if (require.main === module) {
  const projectDir = process.argv[2] || '.';
  if (!fileExists(projectDir)) {
    console.error(`✗ 找不到 ${projectDir}`);
    process.exit(3);
  }
  const problems = checkSchema(projectDir);
  console.log(`結構檢查 — ${path.resolve(projectDir)}\n`);
  if (problems.length === 0) {
    console.log('✓ 機器會讀的表格與欄位都在。');
    process.exit(0);
  }
  for (const p of problems) console.log(`✗ ${p}`);
  console.log('\n結論：有表頭／標題對不上，相關檢查目前是靜默失效狀態，必須先修。');
  process.exit(3);
}
