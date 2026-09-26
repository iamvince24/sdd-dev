'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const git = require('./git');
const { BlockedError } = require('./errors');
const { readJson, writeJson, isInside, now } = require('./fsutil');
const { computeCodebase, sameRef } = require('./codebase');
const { redactBytes } = require('./redact');
const { recordRedaction } = require('./problems');
const { readWorkspace } = require('./profile');
const { stripFrontmatter, sectionMap, parseItems } = require('./spec');
const { readTasks, readVerification, readPlanApproval } = require('./plan');

const COMMAND_METHODS = new Set(['lint', 'type', 'unit', 'integration', 'e2e', 'build']);
const EVIDENCE_METHODS = new Set(['manual', 'browser', 'api']);

function envNames() {
  return process.env.CI ? ['CI'] : [];
}

function commandArgv(command) {
  const args = [];
  const text = String(command);
  let i = 0;
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (i >= text.length) break;
    const quote = text[i] === '"' || text[i] === "'" ? text[i] : '';
    if (quote) i += 1;
    let token = '';
    if (quote) {
      while (i < text.length && text[i] !== quote) token += text[i++];
      if (i >= text.length) throw new BlockedError(`unclosed quote in command: ${command}`);
      i += 1;
    } else {
      while (i < text.length && text[i] !== ' ' && text[i] !== '\t') token += text[i++];
    }
    args.push(token);
  }
  if (!args.length) throw new BlockedError('verify command is empty');
  return args;
}

function resolveCwd(repoRoot, workspaceRel, cwdRel) {
  const base = path.resolve(repoRoot, !workspaceRel || workspaceRel === '.' ? '.' : workspaceRel);
  const cwd = path.resolve(base, !cwdRel || cwdRel === '.' ? '.' : cwdRel);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new BlockedError(`cwd is not a directory: ${cwdRel || '.'}`);
  }
  const realRoot = fs.realpathSync(repoRoot);
  if (!isInside(fs.realpathSync(cwd), realRoot)) throw new BlockedError(`cwd escapes the repo: ${cwdRel || '.'}`);
  return cwd;
}

function runArgv(argv, cwd) {
  const started_at = now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: process.env,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  const finished_at = now();
  const chunks = [result.stdout || Buffer.alloc(0), result.stderr || Buffer.alloc(0)];
  if (result.error) chunks.push(Buffer.from(`${result.error.message}\n`));
  return {
    exit_code: Number.isInteger(result.status) ? result.status : null,
    error_code: result.error && result.error.code ? result.error.code : null,
    output: Buffer.concat(chunks),
    started_at,
    finished_at,
  };
}

function hasKnownFailures(slot) {
  return Array.isArray(slot.known_failures) && slot.known_failures.some((item) => String(item).trim());
}

function failureNames(text) {
  const names = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^not ok\b/.test(line)) {
      names.add(line);
      continue;
    }
    const cargo = line.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED\b/);
    if (cargo) {
      names.add(`FAILED ${cargo[1]}`);
      continue;
    }
    if (/\bFAILED\b/.test(line)) {
      const named = line.match(/\bFAILED\s+(\S+)/);
      names.add(named ? `FAILED ${named[1]}` : 'FAILED');
      continue;
    }
    const fail = line.match(/\bFAIL\s+(\S+)/);
    if (fail) names.add(`FAIL ${fail[1]}`);
  }
  return names;
}

function namesNotIncreased(baselineText, currentText) {
  const baseline = failureNames(baselineText);
  const current = failureNames(currentText);
  if (!baseline.size && !current.size) return false;
  for (const name of current) {
    if (!baseline.has(name)) return false;
  }
  return true;
}

function readOutput(file) {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function baselineDir(runDir, verifyId) {
  return path.join(runDir, 'evidence', 'baseline', verifyId);
}

function writeUnusable(dir, slot, codebaseRef, reason) {
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id: slot.id,
    command: slot.command,
    exit_code: null,
    usable: false,
    reason,
    codebase_ref: codebaseRef,
    started_at: null,
    finished_at: null,
    env: [],
  };
  writeJson(path.join(dir, 'meta.json'), meta);
  return meta;
}

function writeRan(runDir, dir, slot, codebaseRef, ran) {
  fs.mkdirSync(dir, { recursive: true });
  const redacted = redactBytes(ran.output);
  fs.writeFileSync(path.join(dir, 'output.txt'), redacted.bytes);
  const meta = {
    id: slot.id,
    command: slot.command,
    exit_code: ran.exit_code,
    usable: true,
    reason: null,
    codebase_ref: codebaseRef,
    started_at: ran.started_at,
    finished_at: ran.finished_at,
    env: envNames(),
  };
  writeJson(path.join(dir, 'meta.json'), meta);
  if (redacted.changed) recordRedaction(runDir, `evidence/baseline/${slot.id}/output.txt`);
  return meta;
}

function captureBaselineEvidence(repoRoot, runDir, manifest, paths) {
  const ws = manifest.workspaces && manifest.workspaces[0];
  if (!ws || !ws.baseline) return;
  const profile = readWorkspace(paths, ws.id);
  const codebaseRef = ws.baseline.codebase_ref;
  const dirty = Array.isArray(ws.baseline.dirty) ? ws.baseline.dirty : [];
  for (const slot of profile.verify || []) {
    if (!slot || !hasKnownFailures(slot) || slot.absent || !slot.command) continue;
    const dir = baselineDir(runDir, slot.id);
    if (dirty.length) {
      writeUnusable(dir, slot, codebaseRef, 'dirty');
      continue;
    }
    const ran = runArgv(commandArgv(slot.command), resolveCwd(repoRoot, ws.path, slot.cwd));
    writeRan(runDir, dir, slot, codebaseRef, ran);
  }
}

function runInBaselineWorktree(repoRoot, head, ws, slot) {
  const tmp = path.join(os.tmpdir(), `sdd-baseline-${crypto.randomBytes(4).toString('hex')}`);
  const added = git.run(repoRoot, ['worktree', 'add', '--detach', '--', tmp, head]);
  if (added.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new BlockedError((added.stderr || 'git worktree add failed').trim());
  }
  try {
    return runArgv(commandArgv(slot.command), resolveCwd(tmp, ws.path, slot.cwd));
  } finally {
    git.run(repoRoot, ['worktree', 'remove', '--force', '--', tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function ensureBaseline(repoRoot, runDir, ws, slot) {
  const dir = baselineDir(runDir, slot.id);
  const metaPath = path.join(dir, 'meta.json');
  if (fs.existsSync(metaPath)) return readJson(metaPath);
  const dirty = ws.baseline && Array.isArray(ws.baseline.dirty) ? ws.baseline.dirty : [];
  const codebaseRef = ws.baseline && ws.baseline.codebase_ref;
  const head = codebaseRef && codebaseRef.head;
  if (dirty.length || !head) return writeUnusable(dir, slot, codebaseRef, dirty.length ? 'dirty' : 'no baseline head');
  const ran = runInBaselineWorktree(repoRoot, head, ws, slot);
  return writeRan(runDir, dir, slot, codebaseRef, ran);
}

function preexistingHolds(runDir, ac, method, currentText) {
  if (!COMMAND_METHODS.has(method)) return false;
  const dir = baselineDir(runDir, method);
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return false;
  if (!fs.existsSync(path.join(runDir, 'evidence', ac, 'output.txt'))) return false;
  let meta;
  try {
    meta = readJson(metaPath);
  } catch {
    return false;
  }
  if (!meta || meta.usable === false) return false;
  if (!Number.isInteger(meta.exit_code) || meta.exit_code === 0) return false;
  return namesNotIncreased(readOutput(path.join(dir, 'output.txt')), currentText);
}

function preexistingProblems(runDir, runId) {
  const root = path.join(runDir, 'evidence');
  if (!fs.existsSync(root)) return [];
  const problems = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (name === 'baseline') continue;
    const metaPath = path.join(root, name, 'meta.json');
    if (!fs.existsSync(metaPath) || !fs.statSync(metaPath).isFile()) continue;
    let meta;
    try {
      meta = readJson(metaPath);
    } catch (error) {
      problems.push(`${runId} evidence/${name}/meta.json: ${error.message}`);
      continue;
    }
    if (!meta || meta.preexisting !== true) continue;
    const ac = meta.ac || name;
    const output = readOutput(path.join(root, name, 'output.txt'));
    if (!preexistingHolds(runDir, ac, meta.method, output)) {
      problems.push(`${runId} ${ac}: preexisting is not confirmed`);
    }
  }
  return problems;
}

function verificationMethod(runDir, ac) {
  const file = path.join(runDir, 'plan', 'plan.md');
  if (!fs.existsSync(file)) throw new BlockedError('missing plan/plan.md');
  const { body } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
  const item = parseItems(sectionMap(body).map.get('verification')).find((entry) => entry.id === ac);
  if (!item) throw new BlockedError(`plan verification has no ${ac}`);
  if (!item.method) throw new BlockedError(`${ac} verification method is missing`);
  return item.method;
}

function acceptanceIds(runDir) {
  const file = path.join(runDir, 'spec', 'execution-spec.md');
  if (!fs.existsSync(file)) return [];
  const { body } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
  return parseItems(sectionMap(body).map.get('acceptance'))
    .map((item) => item.id)
    .filter((id) => /^AC-[1-9][0-9]*$/.test(id || ''));
}

function observe(runDir, ac, currentRef) {
  const metaPath = path.join(runDir, 'evidence', ac, 'meta.json');
  if (!fs.existsSync(metaPath)) return { status: 'not_run', stale: false, preexisting: false };
  const meta = readJson(metaPath);
  const stale = !!(meta.codebase_ref && currentRef && !sameRef(meta.codebase_ref, currentRef));
  if (meta.stale !== stale) {
    meta.stale = stale;
    writeJson(metaPath, meta);
  }
  return {
    status: meta.status || 'not_run',
    stale,
    preexisting: meta.preexisting === true,
  };
}

function deferredProblems(runDir, runId) {
  const problems = [];
  for (const task of readTasks(runDir)) {
    if (task.status === 'deferred' && !task.reason) {
      problems.push(`${runId} ${task.id} is deferred without a reason`);
    }
  }
  return problems;
}

function readApproval(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function carryLines(runDir) {
  const lines = [];
  for (const name of ['spec', 'plan']) {
    const doc = readApproval(path.join(runDir, 'approvals', `${name}.json`));
    const from = doc && doc.carried_from;
    if (!from || !from.revision) continue;
    lines.push(`- ${doc.artifact || name} r${doc.revision} carried_from r${from.revision} ${from.impact || ''}`);
  }
  const revokedDir = path.join(runDir, 'approvals', 'revoked');
  if (fs.existsSync(revokedDir)) {
    for (const name of fs.readdirSync(revokedDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const doc = readApproval(path.join(revokedDir, name));
      if (!doc || !Number.isInteger(doc.revision)) continue;
      lines.push(`- ${doc.artifact || name} r${doc.revision} 已推翻 ${doc.reason || ''}`.trim());
    }
  }
  return lines.length ? lines : ['- 無'];
}

function writeReport(repoRoot, runDir, manifest, ac) {
  const ws = manifest.workspaces && manifest.workspaces[0];
  const current = computeCodebase(repoRoot, (ws && ws.path) || '.');
  const ids = acceptanceIds(runDir);
  if (ac && !ids.includes(ac)) ids.push(ac);
  const rows = ids.map((id) => ({ id, ...observe(runDir, id, current.codebase_ref) }));
  const done = rows.length > 0 && rows.every((row) => row.status === 'pass' && !row.stale);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const methods = new Map(readVerification(runDir).map((item) => [item.id, item.method || '']));
  const tasks = readTasks(runDir);
  const lines = ['# report', '', '## 驗收', ''];
  for (const row of rows) {
    const marks = [row.preexisting ? 'preexisting' : '', row.stale ? 'stale' : ''].filter(Boolean).join(' ');
    lines.push(`- ${row.id}: ${row.status}${marks ? ` ${marks}` : ''} evidence/${row.id}/`);
  }
  if (!rows.length) lines.push('- 無');
  lines.push('', '## 完成', '', done ? '完成' : '未完成', '');
  lines.push('## 證據路徑', '');
  if (!rows.length) lines.push('- 無');
  for (const row of rows) lines.push(`- ${row.id}: evidence/${row.id}/`);
  lines.push('', '## 沿用核准', '', ...carryLines(runDir), '');
  const deferred = tasks.filter((task) => task.status === 'deferred' && task.reason);
  const deferredIds = new Set(deferred.map((task) => task.id));
  const remaining = tasks.filter((task) => task.status !== 'done' && !deferredIds.has(task.id));
  lines.push('## 剩餘', '');
  if (!remaining.length) lines.push('- 無');
  for (const task of remaining) lines.push(`- ${task.id}: ${task.status || 'pending'}`);
  lines.push('', '## 延後', '');
  if (!deferred.length) lines.push('- 無');
  for (const task of deferred) lines.push(`- ${task.id}: ${task.reason}`);
  lines.push('', '## 能力缺口', '');
  const limits = (manifest && manifest.capability_limits) || [];
  if (!limits.length) lines.push('- 無');
  for (const limit of limits) lines.push(`- ${limit.op} ${limit.layer} ${limit.gap || ''}`.trim());
  const describe = (list) => (list.length ? list.map((row) => `${row.id} ${row.status}${row.stale ? ' stale' : ''}`).join(', ') : '無');
  const taskRows = [];
  const integrationRows = [];
  for (const row of rows) {
    if (methods.get(row.id) === 'integration') integrationRows.push(row);
    else taskRows.push(row);
  }
  lines.push(
    '',
    '## 整合檢查',
    '',
    `- 各任務自己的檢查: ${describe(taskRows)}`,
    `- 整合檢查: ${describe(integrationRows)}`,
    `- 最終驗收: ${done ? '完成' : '未完成'}`,
    '',
  );
  let approval = null;
  try {
    approval = readPlanApproval(runDir);
  } catch {
    approval = null;
  }
  if (!approval || approval.auto_commit !== true) {
    lines.push('## 建議 commit', '');
    if (!tasks.length) lines.push('- 無');
    for (const task of tasks) {
      lines.push(`- ${task.id}: ${task.paths || ''}`);
      lines.push(`  message: ${task.commit || task.id}`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(runDir, 'report.md'), `${lines.join('\n')}`);
  return done;
}

function acMeta(fields) {
  return {
    ac: fields.ac,
    status: fields.status,
    preexisting: fields.preexisting === true,
    stale: fields.stale === true,
    method: fields.method,
    command: fields.command || null,
    exit_code: Number.isInteger(fields.exit_code) ? fields.exit_code : null,
    cwd: fields.cwd || null,
    started_at: fields.started_at || null,
    finished_at: fields.finished_at || null,
    codebase_ref: fields.codebase_ref || null,
    env: Array.isArray(fields.env) ? fields.env : [],
    source: fields.source || null,
    ...(fields.reason ? { reason: fields.reason } : {}),
  };
}

function writeAc(runDir, ac, fields) {
  const dir = path.join(runDir, 'evidence', ac);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'meta.json'), acMeta(fields));
}

function verifyAc({ repoRoot, runDir, manifest, paths, ac }) {
  const method = verificationMethod(runDir, ac);
  const ws = manifest.workspaces && manifest.workspaces[0];
  if (!ws) throw new BlockedError('run has no workspace');
  const profile = readWorkspace(paths, ws.id);
  const dir = path.join(runDir, 'evidence', ac);

  if (EVIDENCE_METHODS.has(method)) {
    const output = path.join(dir, 'output.txt');
    if (fs.existsSync(output) && fs.statSync(output).isFile()) {
      let previous = {};
      const metaPath = path.join(dir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try { previous = readJson(metaPath); } catch { previous = {}; }
      }
      const current = computeCodebase(repoRoot, ws.path || '.');
      const codebaseRef = previous.codebase_ref || current.codebase_ref;
      writeAc(runDir, ac, {
        ac,
        status: 'pass',
        preexisting: false,
        stale: !sameRef(codebaseRef, current.codebase_ref),
        method,
        source: 'evidence',
        codebase_ref: codebaseRef,
        started_at: previous.written_at || previous.started_at || null,
        finished_at: previous.written_at || previous.finished_at || null,
      });
    } else {
      writeAc(runDir, ac, { ac, status: 'not_run', method });
    }
  } else if (COMMAND_METHODS.has(method)) {
    const slot = (profile.verify || []).find((item) => item && item.id === method);
    if (!slot || slot.absent || !slot.command) {
      const reason = (slot && slot.reason) || `no ${method} command`;
      writeAc(runDir, ac, { ac, status: 'blocked', method, command: slot && slot.command, cwd: slot && slot.cwd, reason });
    } else if (hasKnownFailures(slot)) {
      const baseline = ensureBaseline(repoRoot, runDir, ws, slot);
      if (!baseline || baseline.usable === false) {
        writeAc(runDir, ac, {
          ac,
          status: 'blocked',
          method,
          command: slot.command,
          cwd: slot.cwd || '.',
          reason: (baseline && baseline.reason) || 'dirty',
        });
      } else {
        runCommandAc({ repoRoot, runDir, ws, ac, method, slot });
      }
    } else {
      runCommandAc({ repoRoot, runDir, ws, ac, method, slot });
    }
  } else {
    throw new BlockedError(`${ac} verification method is invalid: ${method}`);
  }

  const done = writeReport(repoRoot, runDir, manifest, ac);
  const meta = readJson(path.join(runDir, 'evidence', ac, 'meta.json'));
  console.log(`verify ${ac} ${meta.status}`);
  if (meta.reason) console.log(`reason ${meta.reason}`);
  console.log(`evidence evidence/${ac}/`);
  console.log(done ? '完成' : '未完成');
  return 0;
}

function runCommandAc({ repoRoot, runDir, ws, ac, method, slot }) {
  const cwdRel = slot.cwd || '.';
  const ran = runArgv(commandArgv(slot.command), resolveCwd(repoRoot, ws.path, cwdRel));
  if (ran.error_code === 'EACCES' || ran.error_code === 'EPERM') {
    writeAc(runDir, ac, {
      ac,
      status: 'blocked',
      preexisting: false,
      stale: false,
      method,
      command: slot.command,
      exit_code: null,
      cwd: cwdRel,
      started_at: ran.started_at,
      finished_at: ran.finished_at,
      reason: 'permission',
      source: 'command',
    });
    return;
  }
  const dir = path.join(runDir, 'evidence', ac);
  fs.mkdirSync(dir, { recursive: true });
  const redacted = redactBytes(ran.output);
  fs.writeFileSync(path.join(dir, 'output.txt'), redacted.bytes);
  if (redacted.changed) recordRedaction(runDir, `evidence/${ac}/output.txt`);
  const codebaseRef = computeCodebase(repoRoot, ws.path || '.').codebase_ref;
  const failed = ran.exit_code !== 0;
  const currentText = redacted.bytes.toString('utf8');
  writeAc(runDir, ac, {
    ac,
    status: failed ? 'fail' : 'pass',
    preexisting: failed && preexistingHolds(runDir, ac, method, currentText),
    stale: false,
    method,
    command: slot.command,
    exit_code: ran.exit_code,
    cwd: cwdRel,
    started_at: ran.started_at,
    finished_at: ran.finished_at,
    codebase_ref: codebaseRef,
    env: envNames(),
    source: 'command',
  });
}

module.exports = {
  commandArgv,
  failureNames,
  captureBaselineEvidence,
  preexistingProblems,
  deferredProblems,
  acceptanceIds,
  writeReport,
  verifyAc,
};
