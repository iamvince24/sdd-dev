'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, now } = require('./fsutil');
const { save } = require('./manifest');
const { computeCodebase } = require('./codebase');
const { normPath, splitPaths, pathsOverlap } = require('./plan');
const { stripFrontmatter, sectionMap, parseItems } = require('./spec');

function taskRoots(runDir) {
  const file = path.join(runDir, 'plan', 'plan.md');
  if (!fs.existsSync(file)) return [];
  const { body } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
  const roots = [];
  for (const task of parseItems(sectionMap(body).map.get('tasks'))) {
    roots.push(...splitPaths(task.paths));
  }
  return roots;
}

function outputRoots(configDir, workspaceId) {
  const file = path.join(configDir, 'workspaces.json');
  if (!fs.existsSync(file)) return [];
  let doc;
  try {
    doc = readJson(file);
  } catch {
    return [];
  }
  const entry = (doc.workspaces || []).find((item) => item && item.id === workspaceId);
  if (!entry) return [];
  const roots = [];
  for (const slot of entry.verify || []) {
    if (!slot || !Array.isArray(slot.outputs)) continue;
    for (const item of slot.outputs) {
      const rel = normPath(item);
      if (rel) roots.push(rel);
    }
  }
  return roots;
}

function covered(file, roots) {
  return roots.some((root) => root === '.' || pathsOverlap(file, root));
}

function addedPaths(currentDirty, baselineDirty) {
  const baseline = new Set((baselineDirty || []).map((file) => normPath(file)).filter(Boolean));
  const added = [];
  for (const file of currentDirty || []) {
    const rel = normPath(file);
    if (!rel || rel === '.sdd-dev' || rel.startsWith('.sdd-dev/')) continue;
    if (baseline.has(rel)) continue;
    added.push(rel);
  }
  return added;
}

function reassessPaths(reason) {
  if (typeof reason !== 'string' || !reason.startsWith('route_reassess:')) return null;
  return reason.slice('route_reassess:'.length).split(',').map((part) => part.trim()).filter(Boolean).sort();
}

function samePathSet(reason, files) {
  const previous = reassessPaths(reason);
  if (!previous) return false;
  return previous.join('\0') === [...files].sort().join('\0');
}

function appendReassess(runDir, manifest, files) {
  const history = Array.isArray(manifest.route_history) ? manifest.route_history : [];
  const last = history[history.length - 1];
  if (last && samePathSet(last.reason, files)) return false;
  const mods = manifest.modifiers || {};
  history.push({
    at: now(),
    route: manifest.route,
    modifiers: {
      fast_lane: mods.fast_lane === true,
      cross_check: mods.cross_check === true,
      no_delegation: mods.no_delegation === true,
      plan_only: mods.plan_only === true,
    },
    reason: `route_reassess: ${[...files].sort().join(', ')}`,
    by: 'auto',
  });
  manifest.route_history = history;
  save(runDir, manifest);
  return true;
}

function checkDev(repoRoot, runDir, runId, paths) {
  const problems = [];
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    problems.push(`${runId} missing manifest.json`);
    return { problems, reassess: [] };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    problems.push(`${runId} manifest.json: ${error.message}`);
    return { problems, reassess: [] };
  }
  const tasks = taskRoots(runDir);
  const outside = [];
  for (const ws of manifest.workspaces || []) {
    if (!ws) continue;
    const current = computeCodebase(repoRoot, ws.path || '.');
    const baseline = ws.baseline && Array.isArray(ws.baseline.dirty) ? ws.baseline.dirty : [];
    const roots = [...tasks, ...outputRoots(paths.config, ws.id)];
    for (const file of addedPaths(current.dirty, baseline)) {
      if (!covered(file, roots)) outside.push(file);
    }
  }
  const unique = [...new Set(outside)].sort();
  for (const file of unique) problems.push(`${runId} 越界 ${file}`);
  if (unique.length) appendReassess(runDir, manifest, unique);
  return { problems, reassess: unique };
}

module.exports = { checkDev };
