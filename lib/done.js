'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./fsutil');
const { computeCodebase, sameRef } = require('./codebase');
const { readTasks, currentPlanRevision, splitIds } = require('./plan');
const { acceptanceIds, preexistingProblems, deferredProblems } = require('./verify');
const { flagTrue, loadReview, unresolvedBlocking } = require('./review');
const { delegationUnsupported } = require('./capabilities');

function readMeta(runDir, ac) {
  const dir = path.join(runDir, 'evidence', ac);
  const metaPath = path.join(dir, 'meta.json');
  const output = path.join(dir, 'output.txt');
  const own = fs.existsSync(output) && fs.statSync(output).isFile();
  if (!fs.existsSync(metaPath) || !fs.statSync(metaPath).isFile()) {
    return { meta: null, own };
  }
  try {
    return { meta: readJson(metaPath), own };
  } catch (error) {
    return { meta: null, own, error };
  }
}

function workspaceOf(manifest, workspaceId) {
  const list = (manifest && manifest.workspaces) || [];
  return list.find((item) => item && item.id === workspaceId) || list[0] || null;
}

function acIssues(runDir, repoRoot, manifest, ac) {
  const { meta, own, error } = readMeta(runDir, ac);
  if (error) return [`evidence is unreadable (${error.message})`];
  if (!meta) return ['has no evidence'];
  const issues = [];
  let stale = meta.stale === true;
  if (!stale && meta.codebase_ref && repoRoot) {
    const workspace = workspaceOf(manifest, meta.workspace);
    if (workspace) {
      const current = computeCodebase(repoRoot, workspace.path || '.');
      if (!sameRef(meta.codebase_ref, current.codebase_ref)) stale = true;
    }
  }
  if (stale) issues.push('is stale');
  if (meta.status === 'pass' || meta.preexisting === true) {
    if (!own) issues.push('has no evidence for this run');
  } else {
    issues.push(`is ${meta.status || 'not_run'}`);
  }
  return issues;
}

function executorContextIds(runDir) {
  const dir = path.join(runDir, 'context');
  if (!fs.existsSync(dir)) return [];
  const ids = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.startsWith('executor') || !name.endsWith('.json')) continue;
    try {
      const doc = readJson(path.join(dir, name));
      if (doc && typeof doc.context_id === 'string' && doc.context_id) ids.push(doc.context_id);
    } catch {
      // A broken context file is not an executor id.
    }
  }
  return ids;
}

function noDelegation(manifest) {
  return !!(manifest && manifest.modifiers && manifest.modifiers.no_delegation === true);
}

function crossCheck(manifest) {
  return !!(manifest && manifest.modifiers && manifest.modifiers.cross_check === true);
}

function reviewRequired(manifest) {
  return !!(manifest && (manifest.route === 'full_pipeline' || crossCheck(manifest)));
}

function mappedAcceptance(runDir) {
  const covered = new Set();
  for (const task of readTasks(runDir)) {
    for (const ac of splitIds(task.acceptance)) covered.add(ac);
  }
  return covered;
}

function resultReviewProblems(runDir, runId, manifest) {
  const problems = [];
  const revision = currentPlanRevision(runDir);
  const review = loadReview(runDir, 'result-review', revision);
  const executors = executorContextIds(runDir);
  if (review.exists) {
    const kind = review.fields.reviewer_kind;
    const sameExecutor = kind === 'agent'
      && typeof review.fields.context_id === 'string'
      && executors.includes(review.fields.context_id);
    if (sameExecutor) {
      problems.push(`${runId} ${review.rel}: context_id equals the executor`);
    }
    if (noDelegation(manifest) && kind === 'agent' && flagTrue(review.fields.independent)) {
      problems.push(`${runId} ${review.rel}: reviewer_kind agent cannot be independent under no_delegation`);
    }
    if (kind === 'agent' && flagTrue(review.fields.independent) && delegationUnsupported(manifest && manifest.platform)) {
      problems.push(`${runId} ${review.rel}: platform matrix ${manifest.platform} delegate is not supported`);
    }
  }
  if (!reviewRequired(manifest)) return problems;
  const pendingHuman = noDelegation(manifest) && crossCheck(manifest);
  if (!review.exists) {
    const rel = revision ? `review/result-review-r${revision}.md` : 'review/result-review';
    problems.push(`${runId} ${rel}: result review is missing`);
    if (pendingHuman) problems.push(`${runId} ${rel}: result review is pending_human`);
    return problems;
  }
  const blocking = unresolvedBlocking(review.findings);
  const humanReady = review.verdict === 'READY'
    && !blocking.length
    && review.fields.reviewer_kind === 'human';
  const agentReady = review.verdict === 'READY'
    && !blocking.length
    && review.fields.reviewer_kind === 'agent'
    && flagTrue(review.fields.independent)
    && typeof review.fields.context_id === 'string'
    && review.fields.context_id !== ''
    && !executors.includes(review.fields.context_id)
    && !noDelegation(manifest)
    && !delegationUnsupported(manifest && manifest.platform);
  if (humanReady || agentReady) return problems;
  if (pendingHuman) problems.push(`${runId} ${review.rel}: result review is pending_human`);
  else problems.push(`${runId} ${review.rel}: result review is not an independent READY`);
  return problems;
}

function doneProblems(repoRoot, runDir, runId, manifest) {
  const problems = [];
  const spec = path.join(runDir, 'spec', 'execution-spec.md');
  if (!fs.existsSync(spec)) problems.push(`${runId} missing spec/execution-spec.md`);
  const ids = acceptanceIds(runDir);
  if (fs.existsSync(spec) && !ids.length) problems.push(`${runId} spec/execution-spec.md has no acceptance`);
  const covered = mappedAcceptance(runDir);
  for (const ac of ids) {
    if (!covered.has(ac)) problems.push(`${runId} ${ac} is not on a task`);
    for (const issue of acIssues(runDir, repoRoot, manifest, ac)) {
      problems.push(`${runId} ${ac} ${issue}`);
    }
  }
  problems.push(...resultReviewProblems(runDir, runId, manifest));
  problems.push(...preexistingProblems(runDir, runId));
  problems.push(...deferredProblems(runDir, runId));
  return problems;
}

function markDone(repoRoot, runDir, manifest) {
  const runId = (manifest && manifest.run_id) || 'run';
  const problems = doneProblems(repoRoot, runDir, runId, manifest);
  if (problems.length) return { ok: false, problems };
  manifest.status = 'done';
  writeJson(path.join(runDir, 'manifest.json'), manifest);
  return { ok: true, problems: [] };
}

module.exports = { doneProblems, markDone, executorContextIds };
