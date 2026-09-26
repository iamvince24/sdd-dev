'use strict';

const path = require('path');
const { BlockedError } = require('./errors');
const { now } = require('./fsutil');
const { modifiersFrom } = require('./runstore');
const { checkSpec, currentSpecApproval } = require('./spec');
const { checkPlan, planApprovalCovers, readTasks, splitPaths, normPath } = require('./plan');
const { outputRoots } = require('./scope');

const MODIFIER_KEYS = ['fast_lane', 'cross_check', 'no_delegation', 'plan_only'];

function sameModifiers(left, right) {
  return MODIFIER_KEYS.every((key) => left[key] === right[key]);
}

function nextModifiers(current, updates) {
  const next = modifiersFrom(current);
  if (!updates) return next;
  for (const key of MODIFIER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) next[key] = updates[key] === true;
  }
  return next;
}

function changeRoute(manifest, { route, reason, by, modifiers, riskFeatures }) {
  if (!manifest || typeof manifest !== 'object') throw new BlockedError('manifest is missing');
  if (by !== 'user' && by !== 'auto') throw new BlockedError('route by must be user or auto');
  if (typeof reason !== 'string' || !reason.trim()) throw new BlockedError('route reason is required');
  if (typeof route !== 'string' || !route) throw new BlockedError('route is missing');
  const history = Array.isArray(manifest.route_history) ? manifest.route_history.slice() : [];
  const mods = nextModifiers(manifest.modifiers, modifiers);
  const routeChanged = route !== manifest.route;
  const modsChanged = !sameModifiers(mods, modifiersFrom(manifest.modifiers));
  if (!routeChanged && !modsChanged) throw new BlockedError('route and modifiers are unchanged');
  const entry = {
    at: now(),
    route,
    modifiers: modifiersFrom(mods),
    reason: reason.trim(),
    by,
  };
  if (Array.isArray(riskFeatures) && riskFeatures.length) {
    entry.risk_features = riskFeatures.map((item) => String(item));
  }
  history.push(entry);
  manifest.route = route;
  manifest.modifiers = mods;
  manifest.route_history = history;
  return { from: history.length > 1 ? history[history.length - 2].route : route, changed: routeChanged };
}

function repoRootOf(runDir) {
  return path.resolve(runDir, '..', '..', '..');
}

function configDirOf(runDir) {
  return path.join(runDir, '..', '..', 'config');
}

function pushUnique(roots, value) {
  const rel = normPath(value);
  if (!rel || roots.includes(rel)) return;
  roots.push(rel);
}

function writeRootsFor(runDir, manifest) {
  const roots = [`.sdd-dev/runs/${manifest.run_id}/`];
  for (const task of readTasks(runDir)) {
    for (const file of splitPaths(task.paths)) pushUnique(roots, file);
  }
  const configDir = configDirOf(runDir);
  for (const workspace of manifest.workspaces || []) {
    if (!workspace || !workspace.id) continue;
    for (const file of outputRoots(configDir, workspace.id)) pushUnique(roots, file);
  }
  return roots;
}

function implementationAuthorized(runDir, manifest) {
  if (!manifest || manifest.route === 'selected_advisors') return false;
  if (manifest.route === 'direct') {
    const runId = manifest.run_id || 'run';
    if (checkSpec(runDir, runId).problems.length) return false;
    if (checkPlan(runDir, runId, repoRootOf(runDir)).problems.length) return false;
    if (manifest.modifiers && manifest.modifiers.plan_only === true) return planApprovalCovers(runDir);
    return true;
  }
  if (manifest.route === 'full_pipeline') {
    return currentSpecApproval(runDir).ok === true && planApprovalCovers(runDir);
  }
  return false;
}

// Assigns the flag from the current route. Callers that just changed the route
// must set implementation_authorized to false before this, so an upgrade cannot
// keep the previous route's authorization.
function recomputeAuthority(runDir, manifest) {
  if (!manifest || typeof manifest !== 'object') throw new BlockedError('manifest is missing');
  manifest.implementation_authorized = implementationAuthorized(runDir, manifest);
  manifest.write_roots = writeRootsFor(runDir, manifest);
  return manifest;
}

module.exports = { changeRoute, MODIFIER_KEYS, recomputeAuthority };
