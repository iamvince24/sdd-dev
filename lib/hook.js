'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const { projectContext, repoIdForRoot } = require('./resolver');
const { runScript } = require('./run-check');
const { readFile, fileExists, extractSection, parseFirstTable, rowsAsObjects } = require('../scripts/lib/md');
const { listActiveProjects, declaredPathsOf, specBranchOf, currentBranch, matchesDeclaredPath } = require('../scripts/lib/project-detect');

const WRITE_PATTERNS = [
  /\bsed\b[^|]*\s-i\b/, /\bgit\s+apply\b/, /\bgit\s+checkout\s+--\s/, /\bgit\s+restore\b/,
  /\bgit\s+clean\b/, /\bperl\b[^|]*\s-i\b/, /\b(mv|cp|install)\s/, /\btee\b/, /\btruncate\b/,
  />>?\s*[^\s|&]/,
];

function commandTargets(command) {
  if (!WRITE_PATTERNS.some((pattern) => pattern.test(command))) return [];
  return command.split(/[\s'"`;|&()<>]+/).map((value) => value.replace(/^\.\//, '').trim())
    .filter((value) => value && !value.startsWith('-') && /[/.]/.test(value) && !/^\.+$/.test(value));
}

function parsePayload(argv, input) {
  const pathIndex = argv.indexOf('--path');
  if (pathIndex >= 0) return { kind: 'edit', targets: [argv[pathIndex + 1] || ''] };
  const bashIndex = argv.indexOf('--bash');
  if (bashIndex >= 0) return { kind: 'bash', targets: commandTargets(argv[bashIndex + 1] || '') };
  const payload = JSON.parse(input || '{}');
  const toolInput = payload.tool_input || {};
  if (toolInput.file_path) return { kind: 'edit', targets: [toolInput.file_path] };
  if (toolInput.command) return { kind: 'bash', targets: commandTargets(toolInput.command) };
  return { kind: 'unknown', targets: [] };
}

function repoRelative(target, repoRoot) {
  const absolute = path.isAbsolute(target) ? target : path.resolve(repoRoot, target);
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/').replace(/\/+$/, '');
  return relative.startsWith('../') || relative === '..' ? null : relative;
}

function gateStatus(projectDir, gate) {
  const notes = path.join(projectDir, 'notes.md');
  if (!fileExists(notes)) return '';
  const section = extractSection(readFile(notes), /^Gate 狀態$/);
  const row = section && rowsAsObjects(parseFirstTable(section)).find((entry) => (entry.Gate || '').trim().startsWith(gate));
  return row ? (row['狀態'] || '').trim() : '';
}

function selectProject(activeDir, repoRoot, targets) {
  const projects = listActiveProjects(activeDir);
  const branch = currentBranch(repoRoot);
  const byBranch = projects.filter((item) => {
    const declared = specBranchOf(path.join(activeDir, item));
    return branch && declared && declared.includes(branch);
  });
  const byPath = projects.filter((item) => declaredPathsOf(path.join(activeDir, item))
    .some((declared) => targets.some((target) => matchesDeclaredPath(target, declared))));
  if (byBranch.length === 1) return { item: byBranch[0], selectedBy: 'branch', projects, branch };
  if (byPath.length === 1) return { item: byPath[0], selectedBy: 'path', projects, branch };
  if (projects.length === 1) return { item: projects[0], selectedBy: 'only', projects, branch };
  return { item: null, selectedBy: null, projects, branch };
}

function appendLog(projectStateRoot, name, entry) {
  try {
    fs.appendFileSync(path.join(projectStateRoot, name), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (_) { /* fail open */ }
}

function gateHook(repoRoot, argv, input) {
  try {
    const config = loadConfig();
    const repoId = repoIdForRoot(repoRoot, config);
    const context = projectContext(repoId, { config });
    const parsed = parsePayload(argv, input);
    const targets = parsed.targets.map((target) => repoRelative(target, context.repoRoot)).filter(Boolean);
    if (targets.length === 0) return { exitCode: 0, output: '' };
    const activeDir = path.join(context.projectStateRoot, 'active');
    const selection = selectProject(activeDir, context.repoRoot, targets);
    if (!selection.item) return { exitCode: 0, output: '' };
    const itemDir = path.join(activeDir, selection.item);
    const base = { mode: config.hookMode, repoId, item: selection.item, kind: parsed.kind, targets, branch: selection.branch };
    let message = '';
    if (selection.selectedBy === 'branch' && !/已核准|approved/i.test(gateStatus(itemDir, 'G1'))) {
      message = `${repoId}/${selection.item} 的 G1 尚未核准，不能修改程式碼。`;
    } else {
      const declared = declaredPathsOf(itemDir);
      const hit = declared.find((candidate) => targets.some((target) => matchesDeclaredPath(target, candidate)));
      if (!hit) return { exitCode: 0, output: '' };
      const guard = runScript('gate-guard.js', [itemDir, 'G2']);
      if (guard.code !== 1 || !/檢查報告/.test(guard.stdout)) return { exitCode: 0, output: '' };
      message = `${targets.join(', ')} 命中 ${repoId}/${selection.item} 宣告路徑 ${hit}，但 G2 尚未有效核准：\n${guard.message}`;
    }
    appendLog(context.projectStateRoot, '.hook-log', { ...base, verdict: 'blocker' });
    return { exitCode: config.hookMode === 'block' ? 2 : 1, output: `[gate-hook] ${config.hookMode === 'block' ? '' : 'warn-only：'}${message}` };
  } catch (_) {
    return { exitCode: 0, output: '' };
  }
}

const RISKY = [
  { re: /\bgit\s+push\b/, label: 'git push' }, { re: /\bgh\s+pr\s+create\b/, label: 'gh pr create' },
  { re: /\bgh\s+pr\s+merge\b/, label: 'gh pr merge' }, { re: /\bgit\s+merge\b(?!-)/, label: 'git merge' },
];

function pipelineHook(repoRoot, argv, input) {
  try {
    const config = loadConfig();
    const repoId = repoIdForRoot(repoRoot, config);
    const context = projectContext(repoId, { config });
    const bashIndex = argv.indexOf('--bash');
    const command = bashIndex >= 0 ? argv[bashIndex + 1] || '' : ((JSON.parse(input || '{}').tool_input || {}).command || '');
    const risky = RISKY.find((pattern) => pattern.re.test(command));
    if (risky) {
      appendLog(context.projectStateRoot, '.pipeline-hook-log', { branch: 'risky', pattern: risky.label, command });
      return { exitCode: 2, output: `[pipeline-hook] ${risky.label} 禁止由 agent 自動執行。` };
    }
    if (!/\bgit\s+commit\b/.test(command)) return { exitCode: 0, output: '' };
    const selection = selectProject(path.join(context.projectStateRoot, 'active'), context.repoRoot, []);
    if (!selection.item) return { exitCode: 0, output: '' };
    const guard = runScript('pipeline-guard.js', [path.join(context.projectStateRoot, 'active', selection.item)]);
    if (guard.code !== 1 || !/Pipeline 檢查報告/.test(guard.stdout)) return { exitCode: 0, output: '' };
    appendLog(context.projectStateRoot, '.pipeline-hook-log', { branch: 'commit', mode: config.hookMode, verdict: 'blocker', item: selection.item, command });
    return { exitCode: config.hookMode === 'block' ? 2 : 1, output: `[pipeline-hook] ${config.hookMode === 'block' ? '' : 'warn-only：'}${guard.message}` };
  } catch (_) {
    return { exitCode: 0, output: '' };
  }
}

module.exports = { commandTargets, parsePayload, repoRelative, gateHook, pipelineHook };
