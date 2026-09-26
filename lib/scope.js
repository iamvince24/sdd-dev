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

function hasHashMap(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function addedPaths(currentDirty, baselineDirty, currentHashes, baselineHashes) {
  const baseline = new Set((baselineDirty || []).map((file) => normPath(file)).filter(Boolean));
  const compare = hasHashMap(baselineHashes);
  const current = hasHashMap(currentHashes) ? currentHashes : {};
  const added = [];
  for (const file of currentDirty || []) {
    const rel = normPath(file);
    if (!rel || rel === '.sdd-dev' || rel.startsWith('.sdd-dev/')) continue;
    if (!baseline.has(rel)) {
      added.push(rel);
      continue;
    }
    if (!compare) {
      added.push(rel);
      continue;
    }
    const before = Object.prototype.hasOwnProperty.call(baselineHashes, rel) ? baselineHashes[rel] : undefined;
    const after = Object.prototype.hasOwnProperty.call(current, rel) ? current[rel] : undefined;
    if (before !== after) added.push(rel);
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

const LEGACY_NOTE = 'baseline dirty_hashes missing; treating baseline dirty files as a new diff';

function checkDev(repoRoot, runDir, runId, paths) {
  const problems = [];
  const notes = [];
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    problems.push(`${runId} missing manifest.json`);
    return { problems, notes, reassess: [] };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    problems.push(`${runId} manifest.json: ${error.message}`);
    return { problems, notes, reassess: [] };
  }
  const tasks = taskRoots(runDir);
  const outside = [];
  let legacy = false;
  for (const ws of manifest.workspaces || []) {
    if (!ws) continue;
    const stored = ws.baseline && ws.baseline.dirty_hashes;
    if (!hasHashMap(stored)) legacy = true;
    const current = computeCodebase(repoRoot, ws.path || '.');
    const baseline = ws.baseline && Array.isArray(ws.baseline.dirty) ? ws.baseline.dirty : [];
    const roots = [...tasks, ...outputRoots(paths.config, ws.id)];
    const hashes = hasHashMap(stored) ? stored : null;
    for (const file of addedPaths(current.dirty, baseline, current.dirty_hashes, hashes)) {
      if (!covered(file, roots)) outside.push(file);
    }
  }
  if (legacy) notes.push(LEGACY_NOTE);
  const unique = [...new Set(outside)].sort();
  for (const file of unique) problems.push(`${runId} 越界 ${file}`);
  if (unique.length) appendReassess(runDir, manifest, unique);
  return { problems, notes, reassess: unique };
}

module.exports = { checkDev, outputRoots };
