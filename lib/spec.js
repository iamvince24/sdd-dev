'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { readJson, writeJson, now } = require('./fsutil');
const { load } = require('./manifest');
const { redactString } = require('./redact');
const { recordRedaction } = require('./problems');
const { revisionHash } = require('./revision');

const SPEC_KEYS = [
  'sources',
  'clarifications',
  'scope',
  'exclusions',
  'constraints',
  'interfaces',
  'assumptions',
  'deviations',
  'requirements',
  'acceptance',
];

// Diff in these sections cannot reuse an earlier approval (D-8).
const NON_CARRY = new Set([
  'scope',
  'exclusions',
  'constraints',
  'interfaces',
  'requirements',
  'acceptance',
]);

const AC_FIELDS = ['given', 'when', 'then', 'kind', 'pass'];
const KINDS = new Set(['normal', 'error', 'boundary']);

function unquote(value) {
  return String(value).trim().replace(/^["']|["']$/g, '');
}

function stripFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { fields: {}, body: text };
  const end = text.search(/\r?\n---\s*(?:\r?\n|$)/);
  if (end === -1) return { fields: {}, body: text };
  const block = text.slice(text.indexOf('\n') + 1, end);
  const close = text.slice(end).match(/^\r?\n---\s*(?:\r?\n|$)/);
  const body = text.slice(end + close[0].length);
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (match) fields[match[1]] = unquote(match[2]);
  }
  return { fields, body };
}

function sectionMap(body) {
  const re = /<!--\s*sec:([A-Za-z0-9_-]+)\s*-->/g;
  const found = [];
  let match;
  while ((match = re.exec(body))) {
    found.push({ key: match[1], index: match.index, end: match.index + match[0].length });
  }
  const map = new Map();
  const duplicates = [];
  for (let i = 0; i < found.length; i++) {
    const { key, end } = found[i];
    const stop = i + 1 < found.length ? found[i + 1].index : body.length;
    if (map.has(key)) duplicates.push(key);
    else map.set(key, body.slice(end, stop));
  }
  return { map, duplicates };
}

function parseItems(text) {
  const items = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const start = line.match(/^- ([a-z_]+):\s*(.*)$/);
    if (start) {
      current = { [start[1]]: unquote(start[2]) };
      items.push(current);
      continue;
    }
    const cont = line.match(/^  ([a-z_]+):\s*(.*)$/);
    if (cont && current) current[cont[1]] = unquote(cont[2]);
  }
  return items;
}

function changedSections(older, newer) {
  const left = sectionMap(stripFrontmatter(older).body).map;
  const right = sectionMap(stripFrontmatter(newer).body).map;
  const keys = new Set([...left.keys(), ...right.keys()]);
  return [...keys].filter((key) => (left.get(key) || '') !== (right.get(key) || '')).sort();
}

function revisionFile(runDir, revision) {
  return path.join(runDir, 'spec', 'revisions', `r${revision}.md`);
}

function readRel(runDir, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[/\\]/);
  if (parts.includes('..') || parts.includes('.')) return null;
  const abs = path.join(runDir, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return fs.readFileSync(abs, 'utf8');
}

function answeredQuestions(runDir) {
  const text = readRel(runDir, 'clarify/decisions.md');
  if (text == null) return new Set();
  const answered = new Set();
  for (const item of parseItems(stripFrontmatter(text).body)) {
    if (/^Q-[1-9][0-9]*$/.test(item.id || '') && item.answer) answered.add(item.id);
  }
  return answered;
}

function checkItems(runId, map, problems, notes, runDir) {
  const requirements = parseItems(map.get('requirements'));
  const acceptance = parseItems(map.get('acceptance'));
  const requirementIds = new Set();
  for (const item of requirements) {
    if (!/^R-[1-9][0-9]*$/.test(item.id || '')) {
      problems.push(`${runId} spec/execution-spec.md: requirement id is invalid`);
      continue;
    }
    requirementIds.add(item.id);
  }
  const covered = new Set();
  for (const item of acceptance) {
    if (!/^AC-[1-9][0-9]*$/.test(item.id || '')) {
      problems.push(`${runId} spec/execution-spec.md: acceptance id is invalid`);
      continue;
    }
    for (const field of AC_FIELDS) {
      if (!item[field]) problems.push(`${runId} spec/execution-spec.md: ${item.id} missing ${field}`);
    }
    if (item.kind && !KINDS.has(item.kind)) {
      problems.push(`${runId} spec/execution-spec.md: ${item.id} kind is invalid`);
    }
    if (!requirementIds.has(item.requirement)) {
      problems.push(`${runId} spec/execution-spec.md: ${item.id} requirement ${item.requirement || 'missing'} is not a requirement`);
    } else {
      covered.add(item.requirement);
    }
  }
  for (const id of requirementIds) {
    if (!covered.has(id)) problems.push(`${runId} spec/execution-spec.md: ${id} has no acceptance`);
  }

  const answered = answeredQuestions(runDir);
  for (const item of parseItems(map.get('deviations'))) {
    if (!/^Q-[1-9][0-9]*$/.test(item.decision || '')) {
      problems.push(`${runId} spec/execution-spec.md: deviation missing Q-n`);
    } else if (!answered.has(item.decision)) {
      problems.push(`${runId} spec/execution-spec.md: deviation ${item.decision} is not answered`);
    }
  }

  for (const item of parseItems(map.get('assumptions'))) {
    if (item.status !== 'overturned' || !item.id) continue;
    const hits = assumptionHits(runDir, map, item.id);
    notes.push(`assumption ${item.id} overturned: ${hits.length ? hits.join(', ') : 'none'}`);
  }
}

function mentions(item, id) {
  const blob = Object.keys(item).map((key) => `${item[key]}`).join('\n');
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=[^A-Za-z0-9]|$)`).test(blob);
}

function assumptionHits(runDir, map, id) {
  const hits = [];
  for (const item of parseItems(map.get('requirements'))) {
    if (item.id && mentions(item, id)) hits.push(item.id);
  }
  for (const item of parseItems(map.get('acceptance'))) {
    if (item.id && mentions(item, id)) hits.push(item.id);
  }
  let tasks = [];
  try {
    tasks = require('./plan').readTasks(runDir);
  } catch {
    tasks = [];
  }
  for (const item of tasks) {
    if (item.id && mentions(item, id)) hits.push(item.id);
  }
  return hits;
}

function checkCarry(runDir, runId, approval, problems, options = {}) {
  const from = approval.carried_from;
  if (from == null) return;
  const approvalRel = options.approvalRel || 'approvals/spec.json';
  const revisionDir = options.revisionDir || 'spec/revisions';
  const nonCarry = options.nonCarry || NON_CARRY;
  if (!from || !Number.isInteger(from.revision) || from.revision < 1 || from.revision >= approval.revision) {
    problems.push(`${runId} ${approvalRel}: carried_from is invalid`);
    return;
  }
  const impactRel = from.impact;
  const impact = readRel(runDir, impactRel);
  if (impact == null) {
    problems.push(`${runId} ${approvalRel}: carried_from impact missing`);
    return;
  }
  const older = readRel(runDir, `${revisionDir}/r${from.revision}.md`);
  const newer = readRel(runDir, `${revisionDir}/r${approval.revision}.md`);
  if (older == null || newer == null) {
    problems.push(`${runId} ${approvalRel}: carried_from revisions missing`);
    return;
  }
  const listed = new Map();
  for (const item of parseItems(impact)) {
    if (item.section) listed.set(item.section, item);
  }
  for (const key of changedSections(older, newer)) {
    const item = listed.get(key);
    if (!item) problems.push(`${runId} ${impactRel}: missing section ${key}`);
    else {
      if (item.impact !== 'none') problems.push(`${runId} ${impactRel}: ${key} impact is not none`);
      if (!item.reason) problems.push(`${runId} ${impactRel}: ${key} missing reason`);
    }
    if (nonCarry.has(key)) problems.push(`${runId} ${approvalRel}: cannot carry ${key}`);
  }
}

function checkCoverage(runDir, runId, current, problems) {
  const rel = 'approvals/spec.json';
  const abs = path.join(runDir, rel);
  if (!fs.existsSync(abs)) return;
  let doc;
  try {
    doc = readJson(abs);
  } catch (error) {
    problems.push(`${runId} ${rel}: ${error.message}`);
    return;
  }
  if (doc.artifact !== 'execution-spec' || !Number.isInteger(doc.revision)) return;
  if (doc.revision !== current) {
    problems.push(`${runId} ${rel}: revision ${doc.revision} does not cover current revision ${current}`);
    return;
  }
  checkCarry(runDir, runId, doc, problems);
}

function checkSpec(runDir, runId) {
  const problems = [];
  const notes = [];
  const specRel = 'spec/execution-spec.md';
  const specPath = path.join(runDir, specRel);
  if (!fs.existsSync(specPath)) {
    problems.push(`${runId} missing ${specRel}`);
    return { problems, notes };
  }
  const { fields, body } = stripFrontmatter(fs.readFileSync(specPath, 'utf8'));
  const revision = Number(fields.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    problems.push(`${runId} ${specRel}: revision is missing`);
  }
  const { map, duplicates } = sectionMap(body);
  for (const key of duplicates) problems.push(`${runId} ${specRel}: duplicate section ${key}`);
  for (const key of SPEC_KEYS) {
    if (!map.has(key)) problems.push(`${runId} ${specRel}: missing section ${key}`);
  }
  checkItems(runId, map, problems, notes, runDir);
  if (Number.isInteger(revision) && revision >= 1) checkCoverage(runDir, runId, revision, problems);
  problems.push(...require('./clarify').checkClarify(runDir, runId).problems);
  return { problems, notes };
}

function highestFrozen(runDir) {
  const dir = path.join(runDir, 'spec', 'revisions');
  if (!fs.existsSync(dir)) return 0;
  let highest = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^r(\d+)\.md$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

function readCurrentSpec(runDir) {
  const specRel = 'spec/execution-spec.md';
  const specPath = path.join(runDir, specRel);
  if (!fs.existsSync(specPath)) return { ok: false, reason: `missing ${specRel}` };
  const bytes = fs.readFileSync(specPath);
  const { fields, body } = stripFrontmatter(bytes.toString('utf8'));
  const revision = Number(fields.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    return { ok: false, reason: `${specRel}: revision is missing` };
  }
  const frozenRel = `spec/revisions/r${revision}.md`;
  const frozenPath = path.join(runDir, frozenRel);
  if (!fs.existsSync(frozenPath)) return { ok: false, reason: `missing ${frozenRel}` };
  const frozen = fs.readFileSync(frozenPath);
  if (!frozen.equals(bytes)) return { ok: false, reason: `${specRel} does not match ${frozenRel}` };
  return { ok: true, revision, content_hash: revisionHash(frozen), body };
}

// Valid means approvals/spec.json covers the current frozen revision: same
// revision, matching hash, and a carry chain that check --stage spec accepts.
function currentSpecApproval(runDir) {
  const spec = readCurrentSpec(runDir);
  if (!spec.ok) return spec;
  const rel = 'approvals/spec.json';
  const abs = path.join(runDir, rel);
  if (!fs.existsSync(abs)) return { ok: false, reason: `missing ${rel}` };
  let doc;
  try {
    doc = readJson(abs);
  } catch (error) {
    return { ok: false, reason: `${rel}: ${error.message}` };
  }
  if (!doc || doc.artifact !== 'execution-spec' || !Number.isInteger(doc.revision)) {
    return { ok: false, reason: `${rel}: not an execution-spec approval` };
  }
  if (doc.revision !== spec.revision) {
    return { ok: false, reason: `${rel}: revision ${doc.revision} does not cover current revision ${spec.revision}` };
  }
  if (doc.content_hash !== spec.content_hash) {
    return { ok: false, reason: `${rel}: spec/revisions/r${spec.revision}.md hash mismatch` };
  }
  let runId = 'run';
  const manifestPath = path.join(runDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = readJson(manifestPath);
      if (manifest && manifest.run_id) runId = manifest.run_id;
    } catch (error) {
      // The approval file is still checked; a bad manifest does not make it valid.
    }
  }
  const problems = [];
  checkCarry(runDir, runId, doc, problems);
  if (problems.length) return { ok: false, reason: problems[0] };
  return { ok: true, revision: spec.revision, content_hash: spec.content_hash };
}

function readSpecApproval(runDir) {
  const abs = path.join(runDir, 'approvals', 'spec.json');
  if (!fs.existsSync(abs)) return null;
  let doc;
  try {
    doc = readJson(abs);
  } catch (error) {
    throw new BlockedError(`cannot parse approvals/spec.json: ${error.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new BlockedError('approvals/spec.json must be an object');
  }
  return doc;
}

function approveSpec(runDir, { carryFrom = null, changed = null } = {}) {
  const manifest = load(runDir);
  if (!manifest) throw new BlockedError('missing manifest.json');
  const runId = manifest.run_id || 'run';
  const checked = checkSpec(runDir, runId);
  if (checked.problems.length) throw new BlockedError(checked.problems[0]);
  const spec = readCurrentSpec(runDir);
  if (!spec.ok) throw new BlockedError(spec.reason);
  let carried = null;
  if (carryFrom != null) {
    if (!Number.isInteger(carryFrom) || carryFrom < 1 || carryFrom >= spec.revision) {
      throw new BlockedError('carry source must be an earlier spec revision');
    }
    const previous = readSpecApproval(runDir);
    if (!previous || previous.revision !== carryFrom) {
      throw new BlockedError('carry source approval is missing');
    }
    const source = revisionFile(runDir, carryFrom);
    if (!fs.existsSync(source) || previous.content_hash !== revisionHash(fs.readFileSync(source))) {
      throw new BlockedError('carry source approval does not match its revision');
    }
    carried = { revision: carryFrom, impact: `spec/impact/r${spec.revision}.md` };
    const carryProblems = [];
    checkCarry(runDir, runId, { revision: spec.revision, carried_from: carried }, carryProblems);
    if (carryProblems.length) throw new BlockedError(carryProblems[0]);
  }
  const doc = {
    artifact: 'execution-spec',
    revision: spec.revision,
    content_hash: spec.content_hash,
    approved_at: now(),
    carried_from: carried,
  };
  if (changed) doc.changed = changed;
  writeJson(path.join(runDir, 'approvals', 'spec.json'), doc);
  return { revision: spec.revision, content_hash: spec.content_hash };
}

function writeSpec(runDir, text) {
  const redacted = redactString(text);
  const body = redacted.text.endsWith('\n') ? redacted.text : `${redacted.text}\n`;
  const { fields } = stripFrontmatter(body);
  const revision = Number(fields.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new BlockedError('spec revision is missing');
  }
  const higher = highestFrozen(runDir);
  if (higher > revision) throw new BlockedError(`spec/revisions/r${higher}.md exists; cannot write revision ${revision}`);
  const frozen = revisionFile(runDir, revision);
  const bytes = Buffer.from(body, 'utf8');
  if (fs.existsSync(frozen) && !fs.readFileSync(frozen).equals(bytes)) {
    throw new BlockedError(`spec/revisions/r${revision}.md is frozen`);
  }
  const specDir = path.join(runDir, 'spec');
  fs.mkdirSync(path.join(specDir, 'revisions'), { recursive: true });
  fs.writeFileSync(path.join(specDir, 'execution-spec.md'), bytes);
  fs.writeFileSync(frozen, bytes);
  if (redacted.changed) recordRedaction(runDir, 'spec/execution-spec.md');
  return { revision, redacted: redacted.changed };
}

module.exports = {
  SPEC_KEYS,
  stripFrontmatter,
  sectionMap,
  parseItems,
  changedSections,
  checkSpec,
  writeSpec,
  readSpecApproval,
  approveSpec,
  readCurrentSpec,
  currentSpecApproval,
  checkCarry,
  answeredQuestions,
};
