'use strict';

const fs = require('fs');
const path = require('path');
const { readTasks, splitIds } = require('./plan');
const { stripFrontmatter, sectionMap, parseItems } = require('./spec');

const FROZEN = new Set(['awaiting_user', 'stopped', 'done']);

function affectedIds(block) {
  const raw = block && block.affected;
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  return splitIds(raw);
}

function unresolved(block) {
  if (!block || typeof block.id !== 'string' || !block.id) return false;
  if (block.resolved_at) return false;
  if (typeof block.evidence === 'string' && block.evidence.trim()) return false;
  return true;
}

function requirementByAcceptance(runDir) {
  const map = new Map();
  const file = path.join(runDir, 'spec', 'execution-spec.md');
  if (!fs.existsSync(file)) return map;
  const { body } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
  for (const item of parseItems(sectionMap(body).map.get('acceptance'))) {
    if (item.id && item.requirement) map.set(item.id, item.requirement);
  }
  return map;
}

function coveredTaskIds(runDir, tasks, blocks) {
  const requirements = requirementByAcceptance(runDir);
  const seeds = new Set();
  for (const block of blocks) {
    const ids = affectedIds(block);
    if (ids.indexOf('*') !== -1) {
      for (const task of tasks) seeds.add(task.id);
      continue;
    }
    for (const token of ids) {
      if (/^T-[1-9][0-9]*$/.test(token)) seeds.add(token);
      if (/^AC-[1-9][0-9]*$/.test(token)) {
        for (const task of tasks) {
          if (splitIds(task.acceptance).indexOf(token) !== -1) seeds.add(task.id);
        }
      }
      if (/^R-[1-9][0-9]*$/.test(token)) {
        for (const task of tasks) {
          for (const ac of splitIds(task.acceptance)) {
            if (requirements.get(ac) === token) seeds.add(task.id);
          }
        }
      }
    }
  }
  const dependents = new Map();
  for (const task of tasks) {
    for (const dep of splitIds(task.depends)) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(task.id);
    }
  }
  const covered = new Set();
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop();
    if (covered.has(id)) continue;
    covered.add(id);
    const children = dependents.get(id) || [];
    for (const child of children) stack.push(child);
  }
  return covered;
}

// awaiting_user, stopped, and done stay as written. Otherwise the run is
// blocked only when every remaining task is covered by an unresolved block.
// Before a plan exists, a '*' block still blocks the whole run.
function recomputeStatus(runDir, manifest) {
  if (!manifest) return null;
  if (FROZEN.has(manifest.status)) return manifest.status;
  const tasks = runDir ? readTasks(runDir) : [];
  const blocks = (Array.isArray(manifest.blocks) ? manifest.blocks : []).filter(unresolved);
  const remaining = tasks.filter((task) => task.status !== 'done' && task.status !== 'deferred');
  if (!blocks.length) {
    manifest.status = 'active';
    return manifest.status;
  }
  if (!remaining.length) {
    const wholeRun = tasks.length === 0 && blocks.some((block) => affectedIds(block).indexOf('*') !== -1);
    manifest.status = wholeRun ? 'blocked' : 'active';
    return manifest.status;
  }
  const covered = coveredTaskIds(runDir, tasks, blocks);
  const all = remaining.every((task) => covered.has(task.id));
  manifest.status = all ? 'blocked' : 'active';
  return manifest.status;
}

module.exports = { recomputeStatus, affectedIds, unresolved, coveredTaskIds };
