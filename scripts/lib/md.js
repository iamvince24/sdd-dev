'use strict';

// 極輕量的 Markdown 輔助函式，只服務 devplan-v2 模板的固定格式
// （標題 + pipe table），不追求處理任意 Markdown。

const fs = require('fs');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

// 取出從某個標題（heading）開始、到下一個「同級或更高級」標題為止的原始文字（含起始標題本身）。
// headingTextRegex 比對的是標題文字本身（不含開頭的 #）。
function extractSection(content, headingTextRegex) {
  const lines = content.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && headingTextRegex.test(m[2].trim())) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// 解析文字內第一個 pipe table，回傳 { headers, rows }（都是去空白後的字串陣列）。
// 找不到表格回傳 { headers: [], rows: [] }。
function parseFirstTable(text) {
  if (!text) return { headers: [], rows: [] };
  const lines = text.split(/\r?\n/);
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  let tStart = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (isRow(lines[i]) && isSep(lines[i + 1])) {
      tStart = i;
      break;
    }
  }
  if (tStart === -1) return { headers: [], rows: [] };
  const splitRow = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const headers = splitRow(lines[tStart]);
  const rows = [];
  for (let i = tStart + 2; i < lines.length; i++) {
    if (!isRow(lines[i])) break;
    rows.push(splitRow(lines[i]));
  }
  return { headers, rows };
}

// 解析文字內「所有」pipe table，依出現順序回傳陣列。一個 section 底下可能有
// 不只一張表（例如 03-verify.md「逐條 AC 結果」裡先有一張「可以/不可以」對照表，
// 後面才是真正的 AC 結果表），這種情況不能只抓第一張。
function parseAllTables(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const splitRow = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const tables = [];
  let i = 0;
  while (i < lines.length - 1) {
    if (isRow(lines[i]) && isSep(lines[i + 1])) {
      const headers = splitRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      tables.push({ headers, rows });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

// 在文字裡找「表頭包含 requiredHeader」的那一張表（依出現順序取第一個符合的）。
// 找不到回傳空表，呼叫端不需要另外判斷 null。
function findTableByHeader(text, requiredHeader) {
  return parseAllTables(text).find((t) => t.headers.includes(requiredHeader)) || { headers: [], rows: [] };
}

// 把 parseFirstTable 的結果轉成「以表頭為 key」的物件陣列，缺欄補空字串。
function rowsAsObjects({ headers, rows }) {
  return rows.map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] !== undefined ? r[idx] : '';
    });
    return obj;
  });
}

// 這些函式在找不到章節／表頭時一律回空值，呼叫端因此會「安靜地什麼都沒檢查」——
// 那是最危險的失敗模式（輸出看起來是通過的）。requireTable 是給「這張表一定要在」的
// 場合用的：對不上就 throw SchemaError，呼叫端 catch 之後以「結構錯誤」的 exit code 收場，
// 不要當成 Gate 通過。
class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
    this.isSchemaError = true;
  }
}

function requireTable(content, { heading, headers = [], ctx = '' }) {
  const where = ctx ? `${ctx} ` : '';
  const scope = heading ? extractSection(content, heading) : content;
  if (heading && scope === null) {
    throw new SchemaError(`${where}找不到章節 ${heading}（標題文字被改過？）`);
  }
  const required = headers[0];
  const table = required ? findTableByHeader(scope, required) : parseFirstTable(scope);
  if (table.headers.length === 0) {
    throw new SchemaError(`${where}章節 ${heading || '(整份)'} 底下找不到表頭含「${required}」的表格`);
  }
  const missing = headers.filter((h) => !table.headers.includes(h));
  if (missing.length > 0) {
    throw new SchemaError(
      `${where}表格缺少欄位：${missing.join('、')}（目前表頭：${table.headers.join('、')}）` +
        ' — 表頭文字被改過的話，對應的檢查會靜默失效'
    );
  }
  return table;
}

// 模板裡有一種「欄位 | 內容」的 metadata 表：每一列本身是一組 key-value
//（例如 00-spec.md 開頭那張表：狀態／Tier／Git branch…），不是「表頭 = 欄位名」。
// 這支專門把那種表轉成 { 狀態: '...', Tier: '...' } 這樣的物件。
function parseKeyValueTable(text) {
  const { rows } = parseFirstTable(text);
  const obj = {};
  for (const r of rows) {
    if (r.length >= 2 && r[0]) obj[r[0]] = r[1];
  }
  return obj;
}

module.exports = {
  readFile,
  fileExists,
  extractSection,
  parseFirstTable,
  parseAllTables,
  findTableByHeader,
  rowsAsObjects,
  parseKeyValueTable,
  requireTable,
  SchemaError,
};
