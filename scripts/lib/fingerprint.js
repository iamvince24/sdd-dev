'use strict';

// 文件的「語意指紋」：把一份文件裡真正構成核准標的的內容抽出來、正規化之後 hash。
//
// 為什麼不是整份檔案的 hash：整份 hash 會讓「把任務狀態欄從 todo 改成 done」也使 G2 失效，
// 那正好違反 references/decision-anchors.md 的收尾白名單。取值範圍因此對齊 README.md
// 的失效鏈表 —— 納入的是「改了就該重新核准」的部分，排除的是進度、問答、修訂紀錄。
//
// 正規化把整段文字併成一行再摺疊空白，所以純粹的換行重排（reflow）不會改變指紋；
// 但 AC 本文的錯字修正會 —— 那一條仍然要靠修訂紀錄註明「不影響核准」來豁免。

const crypto = require('crypto');
const { extractSection, findTableByHeader, rowsAsObjects } = require('./md');

// 任務清單裡不納入指紋的欄位：狀態是進度（失效鏈表明訂「非狀態欄」才失效），
// 關聯 Gotcha 是「讀過了」的註記，補填它不等於範圍變動。
const TASK_EXCLUDED_COLUMNS = ['狀態', '關聯 Gotcha'];

function normalize(text) {
  return String(text || '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 取一個章節的內文（不含標題那一行），正規化成單行。找不到章節回空字串。
function sectionBody(content, headingRegex) {
  const section = extractSection(content, headingRegex);
  if (!section) return '';
  return normalize(section.split(/\r?\n/).slice(1).join(' '));
}

function digest(parts) {
  const body = parts.filter((p) => p).join('\n');
  if (!body) return null; // 完全抽不到內容（還是模板／結構不符）時不要給出假的指紋
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8);
}

// 00-spec.md：需求與驗收條件、Non-goals、規格偏離登記。
// 排除 metadata 表（狀態／Tier 會變）、第 9 節問答紀錄、第 10 節修訂紀錄。
function specFingerprint(content) {
  return digest([
    sectionBody(content, /^4\. 需求與驗收條件$/),
    sectionBody(content, /^5\. Non-goals$/),
    sectionBody(content, /^6\. 規格偏離登記$/),
  ]);
}

// 01-plan.md：設計決策與不變量。第 5 節「檔案變更」刻意不納入 —— 它是 02-tasks.md
// 檔案欄的說明版本，範圍變動已經由 tasks 指紋涵蓋。
function planFingerprint(content) {
  return digest([
    sectionBody(content, /^2\. 設計決策$/),
    sectionBody(content, /^6\. 不變量/),
  ]);
}

// 02-tasks.md：任務清單每一列，去掉狀態與關聯 Gotcha 兩欄。
function tasksFingerprint(content) {
  const section = extractSection(content, /^任務清單$/) || content;
  const table = findTableByHeader(section, '服務 AC');
  const rows = rowsAsObjects(table).filter((r) => normalize(r['任務']));
  const parts = rows.map((r) =>
    table.headers
      .filter((h) => !TASK_EXCLUDED_COLUMNS.includes(h))
      .map((h) => normalize(r[h]))
      .join(' | ')
  );
  return digest(parts);
}

const DOC_FINGERPRINTS = {
  '00-spec.md': { key: 'spec', fn: specFingerprint },
  '01-plan.md': { key: 'plan', fn: planFingerprint },
  '02-tasks.md': { key: 'tasks', fn: tasksFingerprint },
};

// 回傳 'spec:a1b2c3d4' 這種可直接貼進表格的字串；抽不到內容時回 null。
function fingerprintFor(docFile, content) {
  const spec = DOC_FINGERPRINTS[docFile];
  if (!spec) return null;
  const hash = spec.fn(content);
  return hash ? `${spec.key}:${hash}` : null;
}

// 從一格自由文字裡挑出某個前綴的指紋（一格可能同時有 plan 與 tasks 兩個）。
function extractFingerprint(cell, key) {
  const m = String(cell || '').match(new RegExp(`${key}:([0-9a-f]{8})`));
  return m ? `${key}:${m[1]}` : null;
}

module.exports = {
  fingerprintFor,
  extractFingerprint,
  specFingerprint,
  planFingerprint,
  tasksFingerprint,
  DOC_FINGERPRINTS,
};
