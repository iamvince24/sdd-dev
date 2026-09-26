'use strict';

const { BlockedError } = require('./errors');
const { now } = require('./fsutil');
const { modifiersFrom } = require('./runstore');

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

module.exports = { changeRoute, MODIFIER_KEYS };
