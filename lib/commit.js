'use strict';

const fs = require('fs');
const path = require('path');
const git = require('./git');
const { readJson } = require('./fsutil');
const { computeCodebase, sameRef } = require('./codebase');
const {
  readTasks,
  splitIds,
  splitPaths,
  normPath,
  pathsOverlap,
  baselineDirty,
  readPlanApproval,
  planApprovalCovers,
} = require('./plan');

function ownEvidence(runDir, ac) {
  const file = path.join(runDir, 'evidence', ac, 'output.txt');
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function readMeta(runDir, ac) {
  const file = path.join(runDir, 'evidence', ac, 'meta.json');
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function stagedPaths(repoRoot) {
  const result = git.run(repoRoot, ['diff', '--cached', '--name-only', '-z']);
  if (result.status !== 0) return { error: (result.stderr || 'git diff failed').trim(), paths: [] };
  return { error: null, paths: result.stdout.split('\0').filter(Boolean).map((file) => normPath(file)) };
}

function headOf(repoRoot) {
  const result = git.run(repoRoot, ['rev-parse', 'HEAD']);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function commitProblems(repoRoot, runDir, runId, taskId) {
  const problems = [];
  let approval = null;
  try {
    approval = readPlanApproval(runDir);
  } catch (error) {
    problems.push(`${runId} ${error.message}`);
    return problems;
  }
  if (!approval || approval.auto_commit !== true) {
    problems.push(`${runId} plan approval auto_commit is not true`);
  }
  if (!planApprovalCovers(runDir)) {
    problems.push(`${runId} plan approval does not cover the current revision`);
  }
  const task = readTasks(runDir).find((item) => item.id === taskId);
  if (!task) {
    problems.push(`${runId} ${taskId} is not a task`);
    return problems;
  }
  const acs = splitIds(task.acceptance);
  if (!acs.length) problems.push(`${runId} ${taskId} has no acceptance`);
  let manifest = null;
  try {
    manifest = readJson(path.join(runDir, 'manifest.json'));
  } catch (error) {
    problems.push(`${runId} manifest.json: ${error.message}`);
  }
  const workspace = manifest && manifest.workspaces && manifest.workspaces[0];
  const current = workspace ? computeCodebase(repoRoot, workspace.path || '.').codebase_ref : null;
  for (const ac of acs) {
    let meta = null;
    try {
      meta = readMeta(runDir, ac);
    } catch (error) {
      problems.push(`${runId} ${ac} evidence is unreadable (${error.message})`);
      continue;
    }
    if (!meta) {
      problems.push(`${runId} ${ac} has no evidence`);
      continue;
    }
    if (meta.status !== 'pass') problems.push(`${runId} ${ac} is ${meta.status || 'not_run'}`);
    if (meta.stale === true) problems.push(`${runId} ${ac} is stale`);
    if (!ownEvidence(runDir, ac)) problems.push(`${runId} ${ac} has no evidence for this run`);
    if (current && meta.codebase_ref && !sameRef(meta.codebase_ref, current)) {
      problems.push(`${runId} ${ac} codebase_ref does not match the worktree`);
    } else if (current && !meta.codebase_ref) {
      problems.push(`${runId} ${ac} codebase_ref does not match the worktree`);
    }
  }
  const staged = stagedPaths(repoRoot);
  if (staged.error) problems.push(`${runId} ${staged.error}`);
  if (!staged.error && !staged.paths.length) problems.push(`${runId} nothing staged for ${taskId}`);
  const dirty = new Set(baselineDirty(manifest));
  const roots = splitPaths(task.paths);
  for (const file of staged.paths) {
    if (!roots.some((root) => pathsOverlap(file, root))) {
      problems.push(`${runId} ${file} is outside ${taskId}`);
    }
    if (dirty.has(file)) problems.push(`${runId} ${file} was already dirty at baseline`);
  }
  return problems;
}

function commitTask(repoRoot, runDir, runId, taskId) {
  const problems = commitProblems(repoRoot, runDir, runId, taskId);
  if (problems.length) return { ok: false, problems };
  const task = readTasks(runDir).find((item) => item.id === taskId);
  const message = (task && task.commit) || taskId;
  const before = headOf(repoRoot);
  const result = git.run(repoRoot, [
    '-c', 'user.email=sdd@localhost',
    '-c', 'user.name=sdd',
    '-c', 'commit.gpgsign=false',
    'commit',
    '-m',
    message,
  ]);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'git commit failed').trim();
    return { ok: false, problems: [`${runId} ${detail}`] };
  }
  const parent = git.run(repoRoot, ['rev-parse', 'HEAD^']);
  if (!before || parent.status !== 0 || parent.stdout.trim() !== before) {
    return { ok: false, problems: [`${runId} commit parent is not the previous HEAD`] };
  }
  return { ok: true, problems: [], head: headOf(repoRoot), parent: before };
}

module.exports = { commitProblems, commitTask };
