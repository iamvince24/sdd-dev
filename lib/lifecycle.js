'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { isInside } = require('./fsutil');
const { diffSources } = require('./drift');
const { readTasks, splitIds, planApprovalCovers, checkPlan, currentPlanRevision } = require('./plan');
const { readCurrentSpec, currentSpecApproval, checkSpec, stripFrontmatter, sectionMap, parseItems } = require('./spec');
const { acceptanceIds } = require('./verify');
const { affectedIds, unresolved, coveredTaskIds } = require('./status');
const { readEvents } = require('./events');
const { blockingConflicts } = require('./clarify');

const STATUSES = new Set(['active', 'awaiting_user', 'blocked', 'stopped', 'done']);
const ROUTES = new Set(['direct', 'selected_advisors', 'full_pipeline']);

function issue(kind, id, message, resume) {
  return { kind, id, message, resume: resume || null };
}

function step(kind, id, message, resume = '處理後執行 run next') {
  return { kind, id, affected: id ? [id] : [], reason: message, resume, message };
}

function validManifest(manifest, runDir) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BlockedError('manifest.json must be an object');
  }
  if (!manifest.run_id || !ROUTES.has(manifest.route) || !STATUSES.has(manifest.status)) {
    throw new BlockedError('manifest.json has an invalid run_id, route, or status');
  }
  if (!Array.isArray(manifest.workspaces) || !manifest.workspaces.length ||
      !Array.isArray(manifest.sources) || !manifest.sources.length || !Array.isArray(manifest.blocks || [])) {
    throw new BlockedError('manifest.json has invalid workspaces, sources, or blocks');
  }
  for (const source of manifest.sources) {
    if (!source || typeof source.path !== 'string' || !source.path ||
        typeof source.id !== 'string' || !source.id || !['file', 'stdin'].includes(source.origin) ||
        path.isAbsolute(source.path) || !isInside(path.resolve(runDir, source.path), path.resolve(runDir))) {
      throw new BlockedError('manifest.json has an invalid source');
    }
  }
  for (const workspace of manifest.workspaces) {
    if (!workspace || typeof workspace.id !== 'string' || !workspace.id ||
        typeof workspace.path !== 'string') throw new BlockedError('manifest.json has an invalid workspace');
  }
  if (manifest.stop_after && !/^(?:spec|plan|T-[1-9][0-9]*)$/.test(manifest.stop_after)) {
    throw new BlockedError('manifest.json has invalid stop_after');
  }
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    throw new BlockedError('run directory is missing');
  }
}

function taskSatisfied(task, acProblemIds, knownIds) {
  const ids = splitIds(task.acceptance);
  return ids.length > 0 && ids.every((id) => knownIds.has(id) && !acProblemIds.has(id));
}

function blockedRequired(block, ids, tasks, requiredRequirements) {
  const affected = affectedIds(block);
  if (affected.includes('*')) return true;
  const requiredTasks = new Set(tasks.filter((task) => task.status !== 'deferred').map((task) => task.id));
  return affected.some((id) => ids.includes(id) || requiredTasks.has(id) || requiredRequirements.has(id));
}

function requirementIds(runDir) {
  const file = path.join(runDir, 'spec', 'execution-spec.md');
  if (!fs.existsSync(file)) return new Set();
  const { body } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
  return new Set(parseItems(sectionMap(body).map.get('acceptance'))
    .map((item) => item.requirement).filter(Boolean));
}

function awaitingReason(runDir) {
  const events = readEvents(runDir) || [];
  const waiting = events.filter((entry) => entry.type === 'status' && /^awaiting_user:/.test(entry.reason || ''));
  const latest = waiting[waiting.length - 1];
  return latest && latest.reason || 'manifest status awaiting_user';
}

function stopReached(runDir, manifest, tasks, acProblemIds, knownIds) {
  const stop = manifest.stop_after;
  if (!stop) return false;
  if (stop === 'spec') return readCurrentSpec(runDir).ok;
  if (stop === 'plan') return fs.existsSync(path.join(runDir, 'plan', 'plan.md'));
  const task = tasks.find((entry) => entry.id === stop);
  return !!task && (task.status === 'done' || taskSatisfied(task, acProblemIds, knownIds));
}

function assessLifecycle(repoRoot, runDir, manifest) {
  validManifest(manifest, runDir);
  const runId = manifest.run_id;
  const ids = acceptanceIds(runDir);
  const knownIds = new Set(ids);
  const tasks = readTasks(runDir);
  if (manifest.stop_after && manifest.stop_after.startsWith('T-') &&
      fs.existsSync(path.join(runDir, 'plan', 'plan.md')) &&
      !tasks.some((task) => task.id === manifest.stop_after)) {
    throw new BlockedError(`stop_after ${manifest.stop_after} is not in the current Plan`);
  }
  const done = require('./done');
  const base = done.baseDoneProblems(repoRoot, runDir, runId, manifest);
  const completion_issues = base.map((message) => issue('acceptance', null, message, '補齊或重驗受影響的 AC'));
  const acProblemIds = new Set();
  const mapped = done.mappedAcceptance(runDir);
  for (const id of ids) if (!mapped.has(id) || done.acIssues(runDir, repoRoot, manifest, id).length) acProblemIds.add(id);
  const remaining_tasks = tasks.filter((task) => task.status !== 'deferred' && task.status !== 'done' && !taskSatisfied(task, acProblemIds, knownIds))
    .map((task) => ({ id: task.id, status: task.status || 'pending' }));
  const spec = readCurrentSpec(runDir);
  const planExists = fs.existsSync(path.join(runDir, 'plan', 'plan.md'));
  if (!spec.ok) completion_issues.push(issue('spec', null, `${runId} ${spec.reason}`, '草擬或修正 Spec revision'));
  if (manifest.route !== 'selected_advisors' && !planExists) {
    completion_issues.push(issue('plan', null, `${runId} missing plan/plan.md`, '草擬 Plan'));
  }
  if (manifest.route !== 'selected_advisors' && planExists) {
    const revision = currentPlanRevision(runDir);
    const frozen = revision && path.join(runDir, 'plan', 'revisions', `r${revision}.md`);
    if (!frozen || !fs.existsSync(frozen) || !fs.readFileSync(frozen).equals(fs.readFileSync(path.join(runDir, 'plan', 'plan.md')))) {
      completion_issues.push(issue('plan', null, `${runId} plan/plan.md does not match its frozen revision`, '寫入新的 Plan revision'));
    }
  }
  const specProblems = spec.ok ? checkSpec(runDir, runId).problems : [];
  const planProblems = planExists && spec.ok ? checkPlan(runDir, runId, repoRoot).problems : [];
  const user_actions = [];
  const next_steps = [];
  const limits = [];
  for (const id of blockingConflicts(runDir)) {
    user_actions.push(step('decision', id, `${id} 尚缺使用者決定`, `回答 ${id} 對應問題後執行 run next`));
  }
  const activeBlocks = (manifest.blocks || []).filter(unresolved);
  const covered = coveredTaskIds(runDir, tasks, activeBlocks);
  const neededBlocks = activeBlocks.filter((block) => blockedRequired(block, ids, tasks, requirementIds(runDir)));
  for (const block of neededBlocks) {
    completion_issues.push(issue('block', block.id, `${runId} ${block.id}: ${block.condition || 'unresolved block'}`, `解除 ${block.id} 並附上證據`));
  }
  for (const block of activeBlocks.filter((entry) => !neededBlocks.includes(entry))) {
    limits.push(issue('block', block.id, block.condition || '未解問題', `檢視 ${block.id}`));
  }

  const sourceDrift = diffSources(repoRoot, runDir, manifest.sources).rows;
  for (const source of sourceDrift) {
    completion_issues.push(issue('source', source.path, `${runId} source ${source.path} changed`, '重新檢查來源並更新 Spec／Plan'));
  }
  for (const problem of specProblems) completion_issues.push(issue('spec', null, problem, '修正 Spec'));
  for (const problem of planProblems) completion_issues.push(issue('plan', null, problem, '修正 Plan'));
  if (manifest.route === 'full_pipeline' && spec.ok) {
    const approval = currentSpecApproval(runDir);
    if (!approval.ok) {
      completion_issues.push(issue('approval', 'spec', `${runId} spec approval: ${approval.reason}`, '核准目前的 Spec revision'));
      if (!specProblems.length) {
        user_actions.push(step('approval', 'spec', `${approval.reason}；請核准目前的 Spec revision`));
      }
    }
  }
  if (manifest.route === 'full_pipeline' && planExists && !planApprovalCovers(runDir)) {
    completion_issues.push(issue('approval', 'plan', `${runId} plan approval is missing or invalid`, '核准目前的 Plan revision'));
    if (!planProblems.length) user_actions.push(step('approval', 'plan', 'Plan 核准缺少或失效；請檢視並核准目前的 revision'));
  }
  if (manifest.modifiers && manifest.modifiers.plan_only && planExists && !planApprovalCovers(runDir)) {
    completion_issues.push(issue('approval', 'plan', `${runId} plan_only awaits plan approval`, '檢視 Plan'));
    if (!planProblems.length) user_actions.push(step('approval', 'plan', '已抵達 plan_only 停止點；請檢視並核准 Plan'));
  }
  if (manifest.route !== 'selected_advisors' && spec.ok && planExists) {
    for (const message of require('./prepare').prepareProblems(repoRoot, runDir, runId, manifest)) {
      completion_issues.push(issue('prepare', null, message, '執行 review prepare'));
    }
    for (const message of require('./done').resultReviewProblems(runDir, runId, manifest, repoRoot)) {
      completion_issues.push(issue('review', null, message, '完成有效的 result review'));
    }
  }
  if (manifest.status === 'stopped') {
    completion_issues.push(issue('status', null, `${runId} is stopped`, '由使用者另行決定是否啟動新的工作'));
  }
  if (manifest.status === 'done' && completion_issues.length) {
    return { run_id: runId, status: manifest.status, action: 'stop', reason: 'done_drift', acceptance_passed: acProblemIds.size === 0 && ids.length > 0, can_complete: false, completion_issues, user_actions, next_steps, limits, blocks: activeBlocks, remaining_tasks };
  }
  if (manifest.status === 'done') {
    return { run_id: runId, status: manifest.status, action: 'stop', reason: 'already_done', acceptance_passed: true, can_complete: true, completion_issues, user_actions, next_steps, limits, blocks: activeBlocks, remaining_tasks };
  }
  if (manifest.status === 'stopped') {
    return { run_id: runId, status: manifest.status, action: 'stop', reason: 'user_stopped', acceptance_passed: false, can_complete: false, completion_issues, user_actions, next_steps, limits, blocks: activeBlocks, remaining_tasks };
  }
  if (stopReached(runDir, manifest, tasks, acProblemIds, knownIds)) {
    return { run_id: runId, status: manifest.status, action: 'stop', reason: `stop_after_${manifest.stop_after}`, acceptance_passed: acProblemIds.size === 0 && ids.length > 0, can_complete: false, completion_issues, user_actions, next_steps, limits, blocks: activeBlocks, remaining_tasks };
  }
  if (manifest.route === 'selected_advisors') {
    if (!spec.ok) next_steps.push(step('spec', null, '整理來源與諮詢結論，產出 Spec'));
    else if (specProblems.length) next_steps.push(step('spec', null, '修正諮詢 Spec 的檢查問題'));
    else {
      const prepareIssues = require('./prepare').prepareProblems(repoRoot, runDir, runId, manifest);
      if (prepareIssues.length) next_steps.push(step('prepare', null, '對諮詢結論執行 review prepare'));
      else user_actions.push(step('decision', null, '請檢視諮詢結論並決定後續工作'));
    }
    if (activeBlocks.some((block) => affectedIds(block).includes('*'))) {
      next_steps.length = 0;
      for (const block of neededBlocks) user_actions.push(step('block', block.id, block.condition || '未解阻塞', `解除 ${block.id} 並執行 run next`));
    }
    if (manifest.status === 'awaiting_user') {
      next_steps.length = 0;
      if (!user_actions.length) user_actions.push(step('decision', null, awaitingReason(runDir)));
    }
    return { run_id: runId, status: manifest.status, action: next_steps.length ? 'continue' : 'wait_user', reason: next_steps.length ? 'advisory_work' : 'advisory_delivered', acceptance_passed: false, can_complete: false, completion_issues, user_actions, next_steps, limits, blocks: activeBlocks, remaining_tasks };
  }
  if (!spec.ok) next_steps.push(step('spec', null, `草擬或修正 Spec：${spec.reason}`));
  else if (specProblems.length) next_steps.push(step('spec', null, '修正 Spec 檢查問題'));
  else if (!planExists) next_steps.push(step('plan', null, '草擬 Plan 並檢查任務與驗收'));
  else if (planProblems.length) next_steps.push(step('plan', null, '修正 Plan 檢查問題'));
  if (sourceDrift.length) next_steps.push(step('sources', null, '重新檢查已變更的來源並更新 Spec／Plan'));
  if (manifest.route === 'full_pipeline' && spec.ok && !specProblems.length && !currentSpecApproval(runDir).ok && !user_actions.some((action) => action.id === 'spec')) {
    next_steps.push(step('spec_check', null, '檢查 Spec 後提出核准'));
  }
  if (manifest.modifiers && manifest.modifiers.plan_only && planExists && !planProblems.length && !planApprovalCovers(runDir)) {
    return { run_id: runId, status: manifest.status, action: 'stop', reason: 'plan_only', acceptance_passed: false, can_complete: false, completion_issues, user_actions, next_steps, limits, blocks: activeBlocks, remaining_tasks };
  }
  const approvalPending = user_actions.some((action) => action.kind === 'approval');
  if (planExists && spec.ok && !specProblems.length && !planProblems.length && !sourceDrift.length && !approvalPending && manifest.implementation_authorized === true && !activeBlocks.some((block) => affectedIds(block).includes('*'))) {
    for (const task of tasks) {
      if (task.status === 'deferred' || taskSatisfied(task, acProblemIds, knownIds) || covered.has(task.id)) continue;
      const deps = splitIds(task.depends);
      const ready = deps.every((depId) => {
        const dep = tasks.find((candidate) => candidate.id === depId);
        return dep && (splitIds(dep.acceptance).length ? taskSatisfied(dep, acProblemIds, knownIds) : dep.status === 'done');
      });
      if (ready) next_steps.push(step('task', task.id, `執行 ${task.id}`));
    }
    for (const id of ids) {
      if (acProblemIds.has(id) && !tasks.some((task) => splitIds(task.acceptance).includes(id) && covered.has(task.id))) {
        next_steps.push(step('verify', id, `修復或重驗 ${id}`));
      }
    }
  }
  if (!next_steps.length && ids.length && !acProblemIds.size && !specProblems.length && !planProblems.length &&
      completion_issues.some((entry) => entry.kind === 'prepare')) {
    next_steps.push(step('prepare', null, '執行 review prepare'));
  }
  if (!next_steps.length && ids.length && !acProblemIds.size && !specProblems.length && !planProblems.length &&
      !completion_issues.some((entry) => entry.kind === 'prepare') && completion_issues.some((entry) => entry.kind === 'review')) {
    if (manifest.route === 'full_pipeline' || manifest.modifiers && manifest.modifiers.cross_check) {
      user_actions.push(step('review', null, '需要可信來源的獨立結果審查；完成後可執行 run done'));
    } else {
      next_steps.push(step('review', null, '檢查結果審查狀態'));
    }
  }
  if (activeBlocks.some((block) => affectedIds(block).includes('*'))) next_steps.length = 0;
  if (!next_steps.length && neededBlocks.length && !user_actions.length) {
    for (const block of neededBlocks) {
      user_actions.push(step('block', block.id, `${block.condition || '未解阻塞'}；影響 ${affectedIds(block).join(', ')}`, `解除 ${block.id} 並執行 run next`));
    }
  }
  if (manifest.status === 'awaiting_user') {
    const runnableSibling = activeBlocks.length > 0 && next_steps.some((entry) => entry.kind === 'task');
    if (!runnableSibling) {
      next_steps.length = 0;
      if (!user_actions.length) user_actions.push(step('decision', null, awaitingReason(runDir)));
    }
  }
  const can_complete = completion_issues.length === 0 && ids.length > 0 && manifest.status !== 'awaiting_user';
  let action;
  let reason;
  if (can_complete) { action = 'run_done'; reason = 'completion_ready'; }
  else if (next_steps.length) { action = 'continue'; reason = 'runnable_work'; }
  else if (user_actions.length) { action = 'wait_user'; reason = 'user_action_required'; }
  else if (neededBlocks.length) { action = 'wait_user'; reason = 'all_remaining_blocked'; }
  else { action = 'stop'; reason = 'cannot_confirm'; }
  return { run_id: runId, status: manifest.status, action, reason, acceptance_passed: acProblemIds.size === 0 && ids.length > 0, can_complete, completion_issues, user_actions, next_steps, limits, blocks: activeBlocks, remaining_tasks };
}

module.exports = { assessLifecycle };
