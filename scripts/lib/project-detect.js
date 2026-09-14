'use strict';

// 共用的「這次操作屬於哪一個 active/ 專案」偵測邏輯。原本寫死在 gate-hook.js 裡，
// pipeline-commit-hook.js 需要同一套判斷，所以抽出來共用——判斷規則改了不會兩邊漂移。
//
// 支援 active/<release>/<item> 這類版本分組。若只讀 active/ 第一層，release 目錄會被
// 誤認成項目；它底下沒有 00-spec.md，將導致 branch 與宣告路徑都無法比對，讓 Gate
// 保護靜默失效
// （看起來有檢查、其實沒檢查到）。改成遞迴往下找「真的含有 00-spec.md」的目錄才算專案，
// 這是一次刻意的行為修正，不是零行為變動的重構；gate-hook.js 與 pipeline-commit-hook.js
// 都套用這個修正過的版本。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readFile, fileExists, extractSection, parseFirstTable, rowsAsObjects, parseKeyValueTable } = require('./md');

// 一律化成 repo-relative 再比。以前用 edited.includes(declared) 做子字串比對，
// 宣告 view/ 會命中整個 repo，而 view/service.html 會誤命中 view/service.html.bak。
function toRepoRelative(p, repoRoot) {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join('/').replace(/\/+$/, '');
}

function normalizeDeclared(d) {
  return d.replace(/`/g, '').split(':')[0].trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

// 完全相等，或宣告的是這個路徑的上層目錄。以路徑段（segment）為單位，不是子字串。
function matchesDeclaredPath(targetRel, declared) {
  if (!targetRel || !declared) return false;
  return targetRel === declared || targetRel.startsWith(declared + '/');
}

function declaredPathsOf(projectDir) {
  const tasksPath = path.join(projectDir, '02-tasks.md');
  if (!fileExists(tasksPath)) return [];
  const section = extractSection(readFile(tasksPath), /^任務清單$/) || readFile(tasksPath);
  const rows = rowsAsObjects(parseFirstTable(section)).filter((r) => (r['任務'] || '').trim());
  return rows
    .flatMap((r) => (r['檔案'] || '').split(/[、,]/))
    .map(normalizeDeclared)
    .filter(Boolean);
}

function specBranchOf(projectDir) {
  const specPath = path.join(projectDir, '00-spec.md');
  if (!fileExists(specPath)) return '';
  const meta = parseKeyValueTable(readFile(specPath));
  return (meta['Git branch'] || '').replace(/`/g, '').trim();
}

function currentBranch(repoRoot) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

// 遞迴找出 active/ 底下真正的專案目錄（含 00-spec.md 的那一層），回傳相對於 activeDir
// 的路徑（可能含子目錄，例如 'release-1/sample-item'）。找到含 00-spec.md 的目錄就當成項目、
// 不再往下找（避免把專案自己的 refs/ 等子目錄誤認成另一個專案）；深度上限 3 層純粹是
// 安全閥，避免結構異常時遞迴進整個 repo。
function listActiveProjects(activeDir) {
  if (!fileExists(activeDir)) return [];
  const results = [];
  function walk(dir, rel, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === '00-spec.md')) {
      results.push(rel);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  }
  for (const e of fs.readdirSync(activeDir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(activeDir, e.name), e.name, 1);
  }
  return results;
}

// 依 gate-hook.js 既有邏輯：先比 branch（唯一才用），否則比宣告路徑（唯一才用）；
// 兩者都認不出來時，剛好只有一個專案就直接選它（selectedBy: 'only'），
// 有多個就回傳 ambiguous: true，交給呼叫端決定要不要印訊息、要不要放行——
// 這支只回傳資料，不呼叫 process.exit，副作用留給呼叫端。
function selectProject({ activeDir, repoRoot, outsideTargets = [] }) {
  const projects = listActiveProjects(activeDir);
  const branch = currentBranch(repoRoot);
  if (projects.length === 0) return { project: null, selectedBy: null, projects, ambiguous: false, branch };

  const byBranch = projects.filter((p) => {
    const b = specBranchOf(path.join(activeDir, p));
    return branch && b && b.includes(branch);
  });
  const byPath = projects.filter((p) =>
    declaredPathsOf(path.join(activeDir, p)).some((d) => outsideTargets.some((t) => matchesDeclaredPath(t, d)))
  );

  if (byBranch.length === 1) return { project: byBranch[0], selectedBy: 'branch', projects, ambiguous: false, branch };
  if (byPath.length === 1) return { project: byPath[0], selectedBy: 'path', projects, ambiguous: false, branch };
  if (projects.length === 1) return { project: projects[0], selectedBy: 'only', projects, ambiguous: false, branch };
  return { project: null, selectedBy: null, projects, ambiguous: true, branch };
}

module.exports = {
  toRepoRelative,
  normalizeDeclared,
  matchesDeclaredPath,
  declaredPathsOf,
  specBranchOf,
  currentBranch,
  listActiveProjects,
  selectProject,
};
