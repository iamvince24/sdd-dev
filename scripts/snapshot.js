#!/usr/bin/env node
'use strict';

// 用法：node scripts/snapshot.js <project-dir>
// 例如：node ../../scripts/snapshot.js .
//
// 對應優化 #7：換人接手、隔天回來、或 context 被壓縮之後，
// 不必整份重讀 00-spec / 01-plan / 02-tasks / notes 四個檔案才能搞清楚現況，
// 先跑這支腳本抓出關鍵狀態。唯讀、不連網、有大小上限：快速且不做任何有副作用的事。

const fs = require('fs');
const path = require('path');
const { readFile, fileExists, extractSection, parseFirstTable, rowsAsObjects, parseKeyValueTable } = require('./lib/md');
const { checkSchema } = require('./schema-lint');

const MAX_BYTES = 200 * 1024; // 單一檔案超過這個大小就跳過細讀，只提醒使用者自己看

const projectDir = process.argv[2] || '.';

// 這支的用途是「相信它的輸出」，所以結構對不上時一定要講出來 —— 否則被改掉的標題會讓
// 某一節安靜地印成「(空白)」，而使用者會以為那真的是空的。但不 exit：快照本身仍有價值。
const schemaProblems = checkSchema(projectDir);

function safeRead(p) {
  if (!fileExists(p)) return null;
  const size = fs.statSync(p).size;
  if (size > MAX_BYTES) return { tooBig: true, size };
  return { content: readFile(p) };
}

function printHeader(title) {
  console.log(`\n── ${title} ──`);
}

const specPath = path.join(projectDir, '00-spec.md');
const notesPath = path.join(projectDir, 'notes.md');
const tasksPath = path.join(projectDir, '02-tasks.md');

console.log(`快照 — ${path.resolve(projectDir)}`);

if (schemaProblems.length > 0) {
  console.log('\n⚠ 文件結構與腳本預期不符，下面的內容可能有整節被漏掉，不要照單全收：');
  for (const p of schemaProblems) console.log(`  - ${p}`);
}

// ---------- 00-spec.md metadata ----------
const specFile = safeRead(specPath);
if (!specFile) {
  console.log('\n✗ 找不到 00-spec.md');
} else if (specFile.tooBig) {
  console.log(`\n⚠ 00-spec.md 超過 ${MAX_BYTES} bytes，請自行開啟查看`);
} else {
  const meta = parseKeyValueTable(specFile.content);
  printHeader('Spec 狀態');
  console.log(`狀態：${meta['狀態'] || '(未填)'}`);
  console.log(`Tier：${meta['Tier'] || '(未填)'}`);
  console.log(`Git branch：${meta['Git branch'] || '(未填)'}`);
  console.log(`影響範圍：${meta['影響範圍'] || '(未填)'}`);
}

// ---------- notes.md ----------
const notesFile = safeRead(notesPath);
if (!notesFile) {
  console.log('\n✗ 找不到 notes.md');
} else if (notesFile.tooBig) {
  console.log(`\n⚠ notes.md 超過 ${MAX_BYTES} bytes，請自行開啟查看`);
} else {
  const notes = notesFile.content;

  const gateSection = extractSection(notes, /^Gate 狀態$/);
  const gateRows = gateSection ? rowsAsObjects(parseFirstTable(gateSection)) : [];
  printHeader('Gate 現況');
  for (const r of gateRows) {
    console.log(`${r['Gate']}：${r['狀態'] || '(尚未核准)'} — 核准版本：${r['核准的版本'] || '(未填)'}`);
  }

  const reviewSection = extractSection(notes, /^獨立審查紀錄/);
  const reviewRows = reviewSection
    ? rowsAsObjects(parseFirstTable(reviewSection)).filter((r) => (r['日期'] || '').trim())
    : [];
  printHeader('最近一次獨立審查');
  if (reviewRows.length === 0) {
    console.log('(尚無紀錄)');
  } else {
    const last = reviewRows[reviewRows.length - 1];
    const axes = last['三軸（O／M／C）'];
    console.log(
      `${last['日期']} ${last['角色']} → ${last['Verdict']}` +
        `${axes ? ` [${axes}]` : ''}（${last['處置與理由'] || '(未填處置)'}）` +
        `${last['回指'] ? ` 回指：${last['回指']}` : ''}`
    );
  }

  const wipSection = extractSection(notes, /^進行中$/);
  printHeader('進行中');
  const wipBody = wipSection ? wipSection.split('\n').slice(1).join('\n').trim() : '';
  console.log(wipBody || '(空白)');

  const stuckSection = extractSection(notes, /^卡住/);
  const stuckBody = stuckSection ? stuckSection.split('\n').slice(1).join('\n').trim() : '';
  if (stuckBody) {
    printHeader('卡住 / 需要使用者決定');
    console.log(stuckBody);
  }
}

// ---------- 02-tasks.md ----------
const tasksFile = safeRead(tasksPath);
if (!tasksFile) {
  console.log('\n✗ 找不到 02-tasks.md');
} else if (tasksFile.tooBig) {
  console.log(`\n⚠ 02-tasks.md 超過 ${MAX_BYTES} bytes，請自行開啟查看`);
} else {
  const taskSection = extractSection(tasksFile.content, /^任務清單$/) || tasksFile.content;
  const taskRows = rowsAsObjects(parseFirstTable(taskSection)).filter((r) => (r['任務'] || '').trim());
  const wip = taskRows.filter((r) => (r['狀態'] || '').trim() === 'wip');
  const blocked = taskRows.filter((r) => (r['狀態'] || '').trim() === 'blocked');
  printHeader(`任務（共 ${taskRows.length} 筆）`);
  console.log(`wip：${wip.map((r) => r['#']).join(', ') || '無'}`);
  console.log(`blocked：${blocked.map((r) => r['#']).join(', ') || '無'}`);
}

console.log('');
