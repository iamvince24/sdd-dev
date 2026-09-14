#!/usr/bin/env node
'use strict';

// 用法：node scripts/gate-guard.js <project-dir> <G1|G2|G3>
//       node scripts/gate-guard.js <project-dir> --print-fingerprint
// 例如：node ../../scripts/gate-guard.js . G2
//
// 對應優化 #2（Gate 版本綁定自動偵測）與 #3（強制獨立審查記錄完整）。
// 只做「機器可驗證」的兩件事，不取代人的核准判斷：
//   1. notes.md 記錄的核准標的是否與文件目前的內容一致；不一致又沒有
//      「不影響核准」註記時，回報 Gate 已過期。
//   1.5 這個 Gate 的狀態欄有沒有明確的核准標記（以前只印出來當參考）。
//   2. Tier L 專案的 G2/G3，是否在 notes.md 的獨立審查紀錄表留有對應、且填完整的一列。
//
// 「核准標的」有兩種綁法，以 notes.md Gate 狀態表上有沒有「核准指紋」欄決定：
//   - 有 → 比對語意指紋（lib/fingerprint.js）。這是主要方式：人手寫的版本號忘了升版時，
//     舊做法會安靜通過，指紋不會。
//   - 沒有（舊項目）→ 完全走原本的版本號比對，行為不變。
//
// 這支腳本唯讀，不會把指紋寫進任何檔案 —— 用 --print-fingerprint 印出來、核准時自己貼上。
//
// exit code 有三種語意，呼叫端（含 gate-hook.js）必須分清楚：
//   0 = 通過；1 = 真的有 blocker；3 = 用法或結構錯誤（是腳本/檔案結構問題，不是 Gate 問題）。
// **刻意不用 2** —— 2 在 PreToolUse 的語意是「真的擋下工具執行」，兩套相反的語意共存是地雷。

const path = require('path');
const { readFile, fileExists, extractSection, parseFirstTable, rowsAsObjects, parseKeyValueTable } = require('./lib/md');
const { fingerprintFor, extractFingerprint, DOC_FINGERPRINTS } = require('./lib/fingerprint');
const { assertSchema } = require('./schema-lint');

const projectDir = process.argv[2] || '.';
const gate = (process.argv[3] || '').toUpperCase();

// --print-fingerprint：印出目前三份文件的指紋，核准時貼進 notes.md 的「核准指紋」欄。
if (process.argv[3] === '--print-fingerprint') {
  console.log(`目前的語意指紋 — ${path.resolve(projectDir)}\n`);
  for (const file of Object.keys(DOC_FINGERPRINTS)) {
    const p = path.join(projectDir, file);
    if (!fileExists(p)) continue;
    const fp = fingerprintFor(file, readFile(p));
    console.log(`${file}：${fp || '(抽不到內容，可能還是模板狀態)'}`);
  }
  console.log('\n核准時把對應的指紋貼進 notes.md Gate 狀態表的「核准指紋」欄；');
  console.log('G2 那一列同時要有 plan 與 tasks 兩個。腳本不會自己寫檔。');
  process.exit(0);
}

if (!['G1', 'G2', 'G3'].includes(gate)) {
  console.error('用法：node gate-guard.js <project-dir> <G1|G2|G3>');
  console.error('　　　node gate-guard.js <project-dir> --print-fingerprint');
  process.exit(3);
}

assertSchema(projectDir);

const GATE_DOCS = {
  G1: [{ file: '00-spec.md', label: '00-spec.md' }],
  G2: [
    { file: '01-plan.md', label: '01-plan.md' },
    { file: '02-tasks.md', label: '02-tasks.md' },
  ],
  G3: [{ file: '00-spec.md', label: '00-spec.md' }],
};

const notesPath = path.join(projectDir, 'notes.md');
const specPath = path.join(projectDir, '00-spec.md');
if (!fileExists(notesPath)) {
  console.error(`✗ 找不到 ${notesPath}`);
  process.exit(3);
}
const notes = readFile(notesPath);

let hasBlocker = false;
const lines = [];
function pass(msg) { lines.push(`✓ ${msg}`); }
function fail(msg) { lines.push(`✗ ${msg}`); hasBlocker = true; }
function info(msg) { lines.push(`… ${msg}`); }

// ---------- 讀 Gate 狀態表 ----------
const gateSection = extractSection(notes, /^Gate 狀態$/);
const gateRows = gateSection ? rowsAsObjects(parseFirstTable(gateSection)) : [];
const gateRow = gateRows.find((r) => (r['Gate'] || '').trim().startsWith(gate));

if (!gateRow) {
  console.error(`✗ notes.md 的 Gate 狀態表找不到 ${gate} 這一列`);
  process.exit(3);
}

const FINGERPRINT_COL = '核准指紋';
// 新欄位一律「只在表上真的有這一欄時才檢查」，舊項目的四欄表不會因此被判不合格。
const hasFingerprintCol = gateRows.length > 0 && Object.prototype.hasOwnProperty.call(gateRows[0], FINGERPRINT_COL);
const approvedFingerprintCell = gateRow[FINGERPRINT_COL] || '';
const approvedCell = gateRow['核准的版本'] || '';
const gateStatus = (gateRow['狀態'] || '').trim();
info(`${gate} 目前狀態欄：${gateStatus || '(空白，尚未核准)'}`);

// ---------- 檢查 0：這個 Gate 到底核准過沒有 ----------
// 以前狀態欄只被印出來當參考，於是「人根本還沒核准」在機器層面完全看不見：
// 一個 Tier M 項目可以整份 vTBD、狀態空白，卻拿到「機器可驗證的部分都通過」。
// 狀態欄必須出現明確的核准標記；空白、「待核准」或任何沒有標記的散文一律視為尚未核准
// （預設落在「還沒核准」這一側，是刻意的安全方向）。
const isApproved = /已核准|approved/i.test(gateStatus);
if (!isApproved) {
  fail(
    `${gate} 的狀態欄沒有明確的核准標記（目前：${gateStatus || '空白'}）` +
      ' — 這個 Gate 還沒核准，不能視為通過。核准後請在狀態欄填「已核准」'
  );
} else if (hasFingerprintCol && !/[a-z]+:[0-9a-f]{8}/.test(approvedFingerprintCell)) {
  // 核准沒有綁在任何內容上，之後永遠判不出過期。
  fail(
    `${gate} 狀態欄寫了已核准，但「核准指紋」欄沒有記到任何指紋（目前：${approvedFingerprintCell || '空白'}）` +
      ' — 跑 `gate-guard.js <項目> --print-fingerprint` 取得後貼上'
  );
} else if (!hasFingerprintCol && !/v\d/.test(approvedCell)) {
  fail(
    `${gate} 狀態欄寫了已核准，但「核准的版本」欄沒有記到任何版本（目前：${approvedCell || '空白'}）` +
      ' — 核准綁版本，沒有版本就無法判斷有沒有過期'
  );
} else {
  pass(`${gate} 狀態欄有明確核准標記，且核准標的（${hasFingerprintCol ? '指紋' : '版本'}）有記錄`);
}

// ---------- 檢查 1：版本是否過期 ----------
function getRevisions(docPath) {
  if (!fileExists(docPath)) return null;
  const content = readFile(docPath);
  const section = extractSection(content, /修訂紀錄$/);
  if (!section) return [];
  return rowsAsObjects(parseFirstTable(section)).filter((r) => (r['版本'] || '').trim());
}

function verNum(v) {
  const m = (v || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// 指紋不符時仍然可以被「不影響核准」的修訂註記豁免：指紋涵蓋得了「只改狀態欄／只補證據」，
// 涵蓋不了「AC 本文的錯字」—— 那一條仍然是人工判斷，沿用原本的白名單機制。
function exemptedByRevisionNotes(revisions, fromVer) {
  const later = fromVer === null ? revisions : revisions.filter((r) => {
    const v = verNum(r['版本']);
    return v !== null && v > fromVer;
  });
  return (
    later.length > 0 &&
    later.every((r) => /不影響.*核准/.test(r['內容'] || r['原因'] || r['改了什麼需求'] || ''))
  );
}

for (const doc of GATE_DOCS[gate]) {
  const docPath = path.join(projectDir, doc.file);
  const revisions = getRevisions(docPath);
  if (revisions === null) {
    fail(`找不到 ${docPath}`);
    continue;
  }

  // ---- 指紋比對（notes.md 有「核准指紋」欄時，這才是機器判定的依據）----
  if (hasFingerprintCol) {
    const key = DOC_FINGERPRINTS[doc.file].key;
    const current = fingerprintFor(doc.file, readFile(docPath));
    const approved = extractFingerprint(approvedFingerprintCell, key);
    if (!current) {
      info(`${doc.label} 抽不到可比對的內容（可能還是模板狀態），略過指紋比對`);
    } else if (!approved) {
      if (isApproved) {
        fail(`${doc.label} 沒有記錄核准指紋（核准指紋欄目前：${approvedFingerprintCell || '空白'}）`);
      } else {
        info(`${doc.label} 目前指紋 ${current}，尚未核准過`);
      }
    } else if (approved === current) {
      pass(`${doc.label} 內容指紋與核准時一致（${current}）`);
    } else if (exemptedByRevisionNotes(revisions, null)) {
      pass(`${doc.label} 內容已變（${approved} → ${current}），但修訂紀錄註明「不影響核准」，Gate 仍有效`);
    } else {
      fail(
        `${doc.label} 核准的是 ${approved}，目前內容是 ${current} — 此 Gate 已過期，需要重新核准` +
          '（若只是錯字／排版，在修訂紀錄註明「不影響核准」並更新指紋欄）'
      );
    }
    const currentVerForInfo = revisions.length > 0 ? revisions[revisions.length - 1]['版本'] : '(無修訂紀錄)';
    info(`${doc.label} 版本欄（僅供人讀，不作判定）：核准 ${approvedCell || '空白'} ／ 目前 ${currentVerForInfo}`);
    continue;
  }

  // ---- 舊項目：沿用版本號比對 ----
  if (revisions.length === 0) {
    info(`${doc.file} 沒有修訂紀錄，略過版本比對`);
    continue;
  }
  const currentVer = verNum(revisions[revisions.length - 1]['版本']);
  // 「核准的版本」欄一格裡可能同時有兩份文件（`01-plan.md` vTBD + `02-tasks.md` v3）。
  // 字元類排除反引號，版本號才不會跨過檔名邊界被誤讀 —— 否則 vTBD 會去撿隔壁
  // `02-tasks.md` 的那個 0，把「尚未核准」誤判成「核准的是 v2、已過期」。
  const approvedMatch = approvedCell.match(
    new RegExp(doc.label.replace(/\./g, '\\.') + '`?[^0-9`]*v?(\\d+)')
  );
  if (!approvedMatch) {
    info(`核准版本欄裡沒有 ${doc.label} 的版本紀錄（可能還是 vTBD），視為尚未核准過`);
    continue;
  }
  const approvedVer = parseInt(approvedMatch[1], 10);
  if (approvedVer === currentVer) {
    pass(`${doc.label} 目前版本 v${currentVer}，與核准版本一致`);
    continue;
  }
  // 版本不一致：檢查中間每一次升版是否都註明「不影響核准」
  const laterRevisions = revisions.filter((r) => {
    const v = verNum(r['版本']);
    return v !== null && v > approvedVer;
  });
  const allExempt =
    laterRevisions.length > 0 &&
    laterRevisions.every((r) => {
      const note = r['內容'] || r['原因'] || '';
      return /不影響.*核准/.test(note);
    });
  if (allExempt) {
    pass(
      `${doc.label} 從 v${approvedVer} 升到 v${currentVer}，但每次升版都註明「不影響核准」，Gate 仍有效`
    );
  } else {
    fail(
      `${doc.label} 核准版本是 v${approvedVer}，目前已是 v${currentVer}，` +
        '且升版紀錄沒有全部註明「不影響核准」— 此 Gate 已過期，需要重新核准'
    );
  }
}

// ---------- 檢查 2：Tier L 的獨立審查紀錄是否完整 ----------
const specContent = fileExists(specPath) ? readFile(specPath) : '';
const specMeta = parseKeyValueTable(specContent);
const tierCell = specMeta['Tier'] || '';
const tierMatch = tierCell.match(/[SML]/);
const tier = tierMatch ? tierMatch[0] : null;

if (gate === 'G1') {
  info('G1 不要求獨立審查紀錄（獨立審查從 G2 才開始）');
} else if (tier !== 'L') {
  info(`Tier 判定為 ${tier || '未知（00-spec.md 的 Tier 欄還是 TBD？）'}，非 Tier L 不強制要求獨立審查紀錄`);
} else {
  const reviewSection = extractSection(notes, /^獨立審查紀錄/);
  const reviewRows = reviewSection ? rowsAsObjects(parseFirstTable(reviewSection)) : [];
  const relevantDocLabels = GATE_DOCS[gate].map((d) => d.label);
  const matching = reviewRows.filter((r) => {
    const target = r['審查對象（檔案 + 版本）'] || '';
    return relevantDocLabels.some((label) => target.includes(label));
  });
  if (matching.length === 0) {
    fail(`Tier L 專案的 ${gate} 找不到對應 ${relevantDocLabels.join('/')} 的獨立審查紀錄`);
  } else {
    const incomplete = matching.filter(
      (r) => !(r['Verdict'] || '').trim() || !(r['處置與理由'] || '').trim()
    );
    if (incomplete.length === 0) {
      pass(`Tier L 專案的 ${gate} 有完整的獨立審查紀錄（Verdict + 處置與理由都非空白）`);
    } else {
      fail(`Tier L 專案的 ${gate} 獨立審查紀錄不完整（Verdict 或處置與理由留白），不能只寫「審為 READY」`);
    }

    // AF-3 / AF-9：新欄位只在表上真的有這一欄時才檢查，舊項目的六欄表不會因此被判不合格。
    const AXES_COL = '三軸（O／M／C）';
    const BACKREF_COL = '回指';
    const hasAxesCol = (reviewRows[0] || {}).hasOwnProperty(AXES_COL);
    const hasBackrefCol = (reviewRows[0] || {}).hasOwnProperty(BACKREF_COL);

    if (hasAxesCol) {
      const missingAxes = matching.filter((r) => !(r[AXES_COL] || '').trim());
      if (missingAxes.length > 0) {
        fail(`Tier L 專案的 ${gate} 有審查列沒填三軸（Outcome／Minimality／Conformance）—— 只看 Outcome 擋不住「多做」與「違反既有慣例」`);
      } else {
        const passVerdictButAxisFails = matching.filter(
          (r) => /\bPASS\b/i.test(r['Verdict'] || '') && /BLOCKING|FAIL/i.test(r[AXES_COL] || '')
        );
        if (passVerdictButAxisFails.length > 0) {
          fail(`Tier L 專案的 ${gate} 有審查列 Verdict 寫 PASS，但三軸裡有非 PASS —— 三軸都 PASS 才算總 PASS`);
        } else {
          pass(`Tier L 專案的 ${gate} 的審查列三軸都已填、且與 Verdict 一致`);
        }
      }
    }

    if (hasBackrefCol) {
      const fixWithoutBackref = matching.filter(
        (r) => /FIX/i.test(r['處置與理由'] || '') && !(r[BACKREF_COL] || '').trim()
      );
      if (fixWithoutBackref.length > 0) {
        fail(`Tier L 專案的 ${gate} 有處置為 FIX 但「回指」欄空白的審查列 —— 指不回任何 AC 或既有義務的修正就是範圍擴張`);
      } else {
        pass(`Tier L 專案的 ${gate} 的 FIX 處置都有回指`);
      }
    }
  }
}

// ---------- 輸出 ----------
console.log(`${gate} 檢查報告 — ${path.resolve(projectDir)}\n`);
console.log(lines.join('\n'));
console.log(hasBlocker ? '\n結論：此 Gate 尚不能視為有效核准，請先處理上面標 ✗ 的項目。' : '\n結論：機器可驗證的部分都通過。');

process.exit(hasBlocker ? 1 : 0);
