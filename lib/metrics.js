'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { readJson, writeJson, now } = require('./fsutil');
const { stripFrontmatter, parseItems, readCurrentSpec } = require('./spec');
const { countReviseRounds } = require('./plan');
const { acceptanceIds } = require('./verify');
const { readEvents } = require('./events');

const UNKNOWN = 'unknown';
const OUTCOME_KINDS = new Set(['rework', 'reopen', 'revert']);

function escalationsFrom(history) {
  const list = [];
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1];
    const cur = history[i];
    if (!prev || !cur || prev.route === cur.route) continue;
    list.push({
      from: prev.route,
      to: cur.route,
      reason: cur.reason || UNKNOWN,
      by: cur.by || UNKNOWN,
      at: cur.at || UNKNOWN,
    });
  }
  return list;
}

function riskFeaturesFrom(history) {
  let recorded = false;
  const features = [];
  for (const entry of history) {
    if (!entry || !Array.isArray(entry.risk_features)) continue;
    recorded = true;
    for (const feature of entry.risk_features) {
      if (typeof feature === 'string' && feature && !features.includes(feature)) features.push(feature);
    }
  }
  return recorded ? features : UNKNOWN;
}

function uniqueBlockCount(manifest) {
  if (!manifest || !Array.isArray(manifest.blocks)) return UNKNOWN;
  const ids = new Set();
  for (const block of manifest.blocks) {
    if (block && typeof block.id === 'string' && block.id) ids.add(block.id);
  }
  return ids.size;
}

function clarificationCount(runDir) {
  const file = path.join(runDir, 'clarify', 'decisions.md');
  if (!fs.existsSync(file)) return UNKNOWN;
  const items = parseItems(stripFrontmatter(fs.readFileSync(file, 'utf8')).body);
  return items.filter((item) => /^Q-[1-9][0-9]*$/.test(item.id || '')).length;
}

function countType(events, type) {
  if (!events) return UNKNOWN;
  const count = events.filter((event) => event && event.type === type).length;
  return count ? count : UNKNOWN;
}

function statusName(reason) {
  return String(reason || '').split(':')[0].trim();
}

function durations(events) {
  if (!events) return { active_ms: UNKNOWN, waiting_ms: UNKNOWN };
  const points = events.filter((event) => event && (event.type === 'status' || event.type === 'pending_human'));
  if (points.length < 2) return { active_ms: UNKNOWN, waiting_ms: UNKNOWN };
  points.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  let active = 0;
  let waiting = 0;
  let mode = null;
  let cursor = null;
  for (const event of points) {
    const at = Date.parse(event.at);
    if (cursor != null && mode && !Number.isNaN(at)) {
      const delta = at - cursor;
      if (delta > 0) {
        if (mode === 'waiting') waiting += delta;
        else active += delta;
      }
    }
    if (!Number.isNaN(at)) cursor = at;
    if (event.type === 'pending_human') mode = 'waiting';
    else {
      const status = statusName(event.reason);
      if (status === 'awaiting_user' || status === 'blocked') mode = 'waiting';
      else if (status === 'active') mode = 'active';
      else mode = null;
    }
  }
  return { active_ms: active, waiting_ms: waiting };
}

function changedOutcome(events) {
  if (!events) return UNKNOWN;
  const found = [];
  for (const event of events || []) {
    if (!event || event.type !== 'approval') continue;
    const match = String(event.reason || '').match(/changed ([a-z,]+)/);
    if (!match) continue;
    for (const part of match[1].split(',')) {
      if (part && found.indexOf(part) === -1) found.push(part);
    }
  }
  return found.length ? found : UNKNOWN;
}

function overrideList(events) {
  if (!events) return UNKNOWN;
  const rows = [];
  for (const event of events) {
    if (!event || event.type !== 'override') continue;
    rows.push({ reason: event.reason || '', at: event.at || UNKNOWN });
  }
  return rows.length ? rows : UNKNOWN;
}

function approvalMetric(runDir, events) {
  if (!events) return approvalCount(runDir);
  const requests = events.filter((event) => event && event.type === 'approval_request').length;
  const written = events.filter((event) => event && event.type === 'approval').length;
  if (!requests && !written) return approvalCount(runDir);
  return written;
}
function approvalCount(runDir) {
  const dir = path.join(runDir, 'approvals');
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const name of ['spec.json', 'plan.json']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const doc = readJson(file);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return UNKNOWN;
      count += 1;
    } catch {
      return UNKNOWN;
    }
  }
  return count;
}

function readAc(runDir, ac) {
  const file = path.join(runDir, 'evidence', ac, 'meta.json');
  if (!fs.existsSync(file)) return { status: 'not_run', stale: false };
  try {
    const meta = readJson(file);
    return { status: meta && meta.status ? meta.status : 'not_run', stale: !!(meta && meta.stale === true) };
  } catch {
    return { status: 'not_run', stale: false };
  }
}

function passSnapshot(runDir) {
  const spec = path.join(runDir, 'spec', 'execution-spec.md');
  if (!fs.existsSync(spec)) return null;
  const ids = acceptanceIds(runDir);
  if (!ids.length) return { final: UNKNOWN, notRun: UNKNOWN, blocked: UNKNOWN, first: UNKNOWN };
  const notRun = [];
  const blocked = [];
  let ok = true;
  for (const id of ids) {
    const row = readAc(runDir, id);
    if (row.status === 'not_run') notRun.push(id);
    if (row.status === 'blocked') blocked.push(id);
    if (row.status !== 'pass' || row.stale) ok = false;
  }
  return { final: ok, notRun, blocked, first: ok };
}

function firstPass(existing, revision, snap) {
  const prev = existing && existing.first_pass_success;
  const map = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {};
  if (revision && snap && snap.first !== UNKNOWN && !Object.prototype.hasOwnProperty.call(map, String(revision))) {
    map[String(revision)] = snap.first;
  }
  return Object.keys(map).length ? map : UNKNOWN;
}

function keptOutcomes(existing) {
  if (!existing) return UNKNOWN;
  if (Array.isArray(existing.outcomes) || existing.outcomes === UNKNOWN) return existing.outcomes;
  return UNKNOWN;
}

function buildMetrics(runDir, manifest, existing) {
  const history = Array.isArray(manifest.route_history) ? manifest.route_history : [];
  const spec = readCurrentSpec(runDir);
  const snap = passSnapshot(runDir);
  const events = readEvents(runDir);
  const span = durations(events);
  return {
    run_id: manifest.run_id || UNKNOWN,
    policy_version: manifest.policy_version || UNKNOWN,
    platform: manifest.platform || UNKNOWN,
    models: manifest.models && typeof manifest.models === 'object' && !Array.isArray(manifest.models)
      ? manifest.models
      : UNKNOWN,
    route_initial: history[0] && history[0].route ? history[0].route : UNKNOWN,
    route_final: history.length && history[history.length - 1].route
      ? history[history.length - 1].route
      : (manifest.route || UNKNOWN),
    escalations: history.length ? escalationsFrom(history) : UNKNOWN,
    risk_features: riskFeaturesFrom(history),
    clarifications: clarificationCount(runDir),
    plan_revise_rounds: countReviseRounds(runDir, manifest),
    blocks: uniqueBlockCount(manifest),
    subagents: countType(events, 'subagent'),
    approvals: approvalMetric(runDir, events),
    approval_requests: countType(events, 'approval_request'),
    active_ms: span.active_ms,
    waiting_ms: span.waiting_ms,
    first_pass_success: firstPass(existing, spec.ok ? spec.revision : null, snap),
    final_pass_success: snap ? snap.final : UNKNOWN,
    not_run: snap ? snap.notRun : UNKNOWN,
    blocked: snap ? snap.blocked : UNKNOWN,
    approvals_changed_outcome: changedOutcome(events),
    overrides: overrideList(events),
    outcomes: keptOutcomes(existing),
  };
}

function metricsPath(runDir) {
  return path.join(runDir, 'metrics.json');
}

function readMetrics(runDir) {
  const file = metricsPath(runDir);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse metrics.json: ${error.message}`);
  }
}

function writeMetrics(runDir, manifest) {
  const doc = buildMetrics(runDir, manifest, readMetrics(runDir));
  writeJson(metricsPath(runDir), doc);
  return doc;
}

function appendOutcome(doc, { kind, basis, at }) {
  if (!OUTCOME_KINDS.has(kind)) throw new BlockedError('outcome kind must be rework, reopen, or revert');
  if (typeof basis !== 'string' || !basis.trim()) throw new BlockedError('outcome basis is required');
  const outcomes = Array.isArray(doc.outcomes) ? doc.outcomes.slice() : [];
  outcomes.push({ kind, observed_at: at || now(), basis: basis.trim() });
  return { ...doc, outcomes };
}

module.exports = {
  UNKNOWN,
  buildMetrics,
  writeMetrics,
  readMetrics,
  appendOutcome,
  metricsPath,
};
