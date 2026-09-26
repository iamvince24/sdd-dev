'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { readJson, writeJson, now } = require('./fsutil');
const { redactString } = require('./redact');
const { recordRedaction } = require('./problems');
const { revisionHash } = require('./revision');
const {
  stripFrontmatter,
  sectionMap,
  parseItems,
  readCurrentSpec,
  currentSpecApproval,
} = require('./spec');

const PLAN_KEYS = [
  'goals',
  'scope',
  'constraints',
  'decisions',
  'interfaces',
  'paths',
  'dependencies',
  'tasks',
  'verification',
  'notes',
];

const PLAN_REL = 'plan/plan.md';
const OVERLAP = new Set(['separable', 'blocked']);

function unquote(value) {
  return String(value).trim().replace(/^["']|["']$/g, '');
}

function parseBasedOn(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const end = text.search(/\r?\n---\s*(?:\r?\n|$)/);
  if (end === -1) return null;
  const block = text.slice(text.indexOf('\n') + 1, end);
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => /^based_on:\s*$/.test(line));
  if (start === -1) return null;
  const based = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!/^\s+/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (match) based[match[1]] = unquote(match[2]);
  }
  if (based.revision !== undefined && based.revision !== '') based.revision = Number(based.revision);
  return based;
}

function normPath(value) {
  const text = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  return text.replace(/\/$/, '');
}

function splitPaths(value) {
  return [...new Set(String(value || '').split(',').map((part) => normPath(part)).filter(Boolean))];
}

function splitIds(value) {
  return [...new Set(String(value || '').split(/[,\s]+/).map((part) => part.trim()).filter(Boolean))];
}

function pathsOverlap(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function setsOverlap(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (pathsOverlap(a, b)) return true;
    }
  }
  return false;
}

function reaches(from, to, deps) {
  const seen = new Set([from]);
  const stack = [...(deps.get(from) || [])];
  while (stack.length) {
    const next = stack.pop();
    if (next === to) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const hop of deps.get(next) || []) stack.push(hop);
  }
  return false;
}

function readManifest(runDir) {
  const file = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse manifest.json: ${error.message}`);
  }
}

function writeManifest(runDir, manifest) {
  writeJson(path.join(runDir, 'manifest.json'), manifest);
}

function planFile(runDir) {
  return path.join(runDir, 'plan', 'plan.md');
}

function revisionFile(runDir, revision) {
  return path.join(runDir, 'plan', 'revisions', `r${revision}.md`);
}

function currentPlanRevision(runDir) {
  const file = planFile(runDir);
  if (!fs.existsSync(file)) return null;
  const { fields } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
  const revision = Number(fields.revision);
  if (!Number.isInteger(revision) || revision < 1) return null;
  return revision;
}

function highestFrozen(runDir) {
  const dir = path.join(runDir, 'plan', 'revisions');
  if (!fs.existsSync(dir)) return 0;
  let highest = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^r(\d+)\.md$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

function baselineDirty(manifest) {
  const dirty = [];
  for (const workspace of (manifest && manifest.workspaces) || []) {
    const list = workspace && workspace.baseline && workspace.baseline.dirty;
    if (!Array.isArray(list)) continue;
    for (const file of list) {
      const norm = normPath(file);
      if (norm) dirty.push(norm);
    }
  }
  return [...new Set(dirty)];
}

function flagTrue(value) {
  return value === true || value === 'true';
}

function loadPlanReview(runDir, revision) {
  const rel = `review/plan-review-r${revision}.md`;
  const empty = { exists: false, rel, fields: {}, verdict: '', findings: [] };
  if (!revision) return empty;
  const file = path.join(runDir, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return empty;
  const raw = fs.readFileSync(file, 'utf8');
  const { fields, body } = stripFrontmatter(raw);
  if (fields.revision !== undefined && fields.revision !== '' && Number(fields.revision) !== revision) {
    return empty;
  }
  const verdict = fields.verdict || (fields.artifact === 'plan-review' ? fields.status : '') || '';
  const findings = parseItems(body).filter((item) => (
    item.blocking !== undefined || /^F-[1-9][0-9]*$/.test(item.id || '')
  ));
  return { exists: true, rel, fields, verdict, findings };
}

function unresolvedBlocking(findings) {
  return findings.filter((item) => flagTrue(item.blocking) && !flagTrue(item.resolved));
}

function blockingLabel(item) {
  const id = item.id || 'finding';
  const basis = item.basis || item.dimension || item.kind || '';
  const safety = basis === 'D7' || basis === 'security' || basis === 'safety';
  if (safety) return `${id} safety (${basis})`;
  if (basis) return `${id} (${basis})`;
  return id;
}

function noDelegation(manifest) {
  return !!(manifest && manifest.modifiers && manifest.modifiers.no_delegation === true);
}

function illegalReviewProblems(runDir, revision, manifest, runId) {
  if (!noDelegation(manifest)) return [];
  const review = loadPlanReview(runDir, revision);
  if (!review.exists) return [];
  if (review.fields.reviewer_kind === 'agent' && flagTrue(review.fields.independent)) {
    return [`${runId} ${review.rel}: reviewer_kind agent cannot be independent under no_delegation`];
  }
  return [];
}

// human counts as independent. An agent counts only with independent: true,
// its own context_id, and no_delegation off. Open blocking findings void READY.
function independentReady(review, manifest) {
  if (!review.exists || review.verdict !== 'READY') return false;
  if (unresolvedBlocking(review.findings).length) return false;
  if (review.fields.reviewer_kind === 'human') return true;
  if (review.fields.reviewer_kind !== 'agent' || !flagTrue(review.fields.independent)) return false;
  if (noDelegation(manifest)) return false;
  return typeof review.fields.context_id === 'string' && review.fields.context_id !== '';
}

function readPlanApproval(runDir) {
  const abs = path.join(runDir, 'approvals', 'plan.json');
  if (!fs.existsSync(abs)) return null;
  let doc;
  try {
    doc = readJson(abs);
  } catch (error) {
    throw new BlockedError(`cannot parse approvals/plan.json: ${error.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new BlockedError('approvals/plan.json must be an object');
  }
  if (!Object.prototype.hasOwnProperty.call(doc, 'auto_commit')) doc.auto_commit = false;
  else doc.auto_commit = doc.auto_commit === true;
  return doc;
}

function planApprovalCovers(runDir) {
  let doc;
  try {
    doc = readPlanApproval(runDir);
  } catch (error) {
    return false;
  }
  if (!doc || doc.artifact !== 'plan') return false;
  const revision = currentPlanRevision(runDir);
  if (!revision || doc.revision !== revision) return false;
  const frozenPath = revisionFile(runDir, revision);
  if (!fs.existsSync(frozenPath) || !fs.existsSync(planFile(runDir))) return false;
  const frozen = fs.readFileSync(frozenPath);
  const current = fs.readFileSync(planFile(runDir));
  if (!frozen.equals(current)) return false;
  if (doc.content_hash !== revisionHash(frozen)) return false;
  const spec = readCurrentSpec(runDir);
  const based = doc.based_on_spec;
  if (!spec.ok || !based) return false;
  return based.revision === spec.revision && based.content_hash === spec.content_hash;
}

function tasksInProgress(body) {
  const tasks = parseItems(sectionMap(body).map.get('tasks'));
  return tasks.some((task) => task.status === 'in_progress');
}

// direct: stop when the plan is written. full_pipeline: stop when check sees a READY review.
function applyPlanOnlyStop(runDir, when) {
  const manifest = readManifest(runDir);
  if (!manifest || !manifest.modifiers || manifest.modifiers.plan_only !== true) return null;
  if (manifest.status !== 'active') return null;
  if (when === 'written' && manifest.route === 'full_pipeline') return null;
  if (when === 'reviewed' && manifest.route !== 'full_pipeline') return null;
  const revision = currentPlanRevision(runDir);
  if (when === 'reviewed' && !independentReady(loadPlanReview(runDir, revision), manifest)) return null;
  if (planApprovalCovers(runDir)) return null;
  const file = planFile(runDir);
  if (!fs.existsSync(file)) return null;
  const { body } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
  if (tasksInProgress(body)) return null;
  manifest.status = 'awaiting_user';
  writeManifest(runDir, manifest);
  return 'awaiting_user';
}

function checkBasedOn(runId, based, spec, problems) {
  if (!spec.ok) {
    problems.push(`${runId} ${PLAN_REL}: based_on is not the current spec revision (${spec.reason}); write a new plan revision`);
    return;
  }
  const revisionOk = based && based.artifact === 'execution-spec' && based.revision === spec.revision;
  const hashOk = based && based.content_hash === spec.content_hash;
  if (revisionOk && hashOk) return;
  if (!based || based.revision !== spec.revision) {
    const got = based && based.revision !== undefined && based.revision !== '' ? based.revision : 'missing';
    problems.push(`${runId} ${PLAN_REL}: based_on revision ${got} is not current spec revision ${spec.revision}; write a new plan revision`);
    return;
  }
  problems.push(`${runId} ${PLAN_REL}: based_on does not match current spec revision ${spec.revision}; write a new plan revision`);
}

function checkPlan(runDir, runId) {
  const problems = [];
  const notes = [];
  const file = planFile(runDir);
  if (!fs.existsSync(file)) {
    problems.push(`${runId} missing ${PLAN_REL}`);
    return { problems, notes };
  }
  const raw = fs.readFileSync(file, 'utf8');
  const { fields, body } = stripFrontmatter(raw);
  const based = parseBasedOn(raw);
  const { map, duplicates } = sectionMap(body);
  for (const key of duplicates) problems.push(`${runId} ${PLAN_REL}: duplicate section ${key}`);
  for (const key of PLAN_KEYS) {
    if (!map.has(key)) problems.push(`${runId} ${PLAN_REL}: missing section ${key}`);
  }
  const spec = readCurrentSpec(runDir);
  checkBasedOn(runId, based, spec, problems);
  let manifest = null;
  const manifestPath = path.join(runDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      problems.push(`${runId} manifest.json: ${error.message}`);
    }
  }
  const tasks = parseItems(map.get('tasks'));
  const valid = [];
  const seen = new Set();
  for (const task of tasks) {
    if (!/^T-[1-9][0-9]*$/.test(task.id || '')) {
      problems.push(`${runId} ${PLAN_REL}: task id is invalid`);
      continue;
    }
    if (seen.has(task.id)) problems.push(`${runId} ${PLAN_REL}: duplicate task ${task.id}`);
    seen.add(task.id);
    valid.push({ ...task, pathSet: splitPaths(task.paths) });
  }
  const deps = new Map(valid.map((task) => [task.id, splitIds(task.depends).filter((id) => seen.has(id))]));
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (!setsOverlap(valid[i].pathSet, valid[j].pathSet)) continue;
      const [a, b] = [valid[i].id, valid[j].id].sort();
      if (reaches(valid[i].id, valid[j].id, deps) || reaches(valid[j].id, valid[i].id, deps)) continue;
      problems.push(`${runId} ${PLAN_REL}: ${a} and ${b} paths overlap without a dependency`);
    }
  }
  if (spec.ok) {
    const specMap = sectionMap(spec.body).map;
    const acToR = new Map();
    for (const item of parseItems(specMap.get('acceptance'))) {
      if (item.id && item.requirement) acToR.set(item.id, item.requirement);
    }
    const covered = new Set();
    for (const task of valid) {
      for (const ac of splitIds(task.acceptance)) {
        const requirement = acToR.get(ac);
        if (requirement) covered.add(requirement);
      }
      for (const requirement of splitIds(task.requirement || task.requirements)) covered.add(requirement);
    }
    for (const item of parseItems(specMap.get('requirements'))) {
      if (/^R-[1-9][0-9]*$/.test(item.id || '') && !covered.has(item.id)) {
        problems.push(`${runId} ${PLAN_REL}: ${item.id} has no task`);
      }
    }
  }
  const dirty = baselineDirty(manifest);
  for (const task of valid) {
    const hitsDirty = task.pathSet.some((file) => dirty.some((other) => pathsOverlap(file, other)));
    if (!hitsDirty) continue;
    if (!OVERLAP.has(task.preexisting_overlap)) {
      problems.push(`${runId} ${PLAN_REL}: ${task.id} intersects baseline dirty paths without preexisting_overlap`);
    }
  }
  const approved = planApprovalCovers(runDir);
  const planOnly = manifest && manifest.modifiers && manifest.modifiers.plan_only === true;
  const fullPipeline = manifest && manifest.route === 'full_pipeline';
  if (manifest && !approved && (planOnly || fullPipeline)) {
    for (const task of valid) {
      if (task.status !== 'in_progress') continue;
      if (fullPipeline) problems.push(`${runId} ${PLAN_REL}: ${task.id} cannot be in_progress without a plan approval`);
      else problems.push(`${runId} ${PLAN_REL}: ${task.id} is in_progress`);
    }
  }
  const planRevision = Number(fields.revision);
  if (manifest && Number.isInteger(planRevision) && planRevision >= 1) {
    problems.push(...illegalReviewProblems(runDir, planRevision, manifest, runId));
  }
  return { problems, notes };
}

function writePlan(runDir, text) {
  const redacted = redactString(text);
  const body = redacted.text.endsWith('\n') ? redacted.text : `${redacted.text}\n`;
  const { fields } = stripFrontmatter(body);
  const revision = Number(fields.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new BlockedError('plan revision is missing');
  const manifest = readManifest(runDir);
  if (manifest && manifest.route === 'full_pipeline') {
    const approval = currentSpecApproval(runDir);
    if (!approval.ok) {
      throw new BlockedError(`full_pipeline requires a valid spec approval for the current revision: ${approval.reason}`);
    }
  }
  const higher = highestFrozen(runDir);
  if (higher > revision) throw new BlockedError(`plan/revisions/r${higher}.md exists; cannot write revision ${revision}`);
  const frozen = revisionFile(runDir, revision);
  const bytes = Buffer.from(body, 'utf8');
  if (fs.existsSync(frozen) && !fs.readFileSync(frozen).equals(bytes)) {
    throw new BlockedError(`plan/revisions/r${revision}.md is frozen`);
  }
  fs.mkdirSync(path.join(runDir, 'plan', 'revisions'), { recursive: true });
  fs.writeFileSync(planFile(runDir), bytes);
  fs.writeFileSync(frozen, bytes);
  if (redacted.changed) recordRedaction(runDir, PLAN_REL);
  const status = applyPlanOnlyStop(runDir, 'written');
  return { revision, redacted: redacted.changed, status };
}

function approvePlan(runDir, { autoCommit = false } = {}) {
  const manifest = readManifest(runDir);
  if (!manifest) throw new BlockedError('missing manifest.json');
  const runId = manifest.run_id || 'run';
  const checked = checkPlan(runDir, runId);
  if (checked.problems.length) throw new BlockedError(checked.problems[0]);
  const revision = currentPlanRevision(runDir);
  if (!revision) throw new BlockedError('plan revision is missing');
  if (manifest.route === 'full_pipeline') {
    const review = loadPlanReview(runDir, revision);
    const blocking = unresolvedBlocking(review.findings);
    if (blocking.length) {
      const labels = blocking.map(blockingLabel).join(', ');
      throw new BlockedError(`${runId} ${review.rel}: unresolved blocking ${labels}`);
    }
    if (!independentReady(review, manifest)) {
      throw new BlockedError(`full_pipeline requires an independent READY plan review for revision ${revision}`);
    }
  }
  const spec = readCurrentSpec(runDir);
  if (!spec.ok) throw new BlockedError(spec.reason);
  const frozen = fs.readFileSync(revisionFile(runDir, revision));
  const doc = {
    artifact: 'plan',
    revision,
    content_hash: revisionHash(frozen),
    based_on_spec: { revision: spec.revision, content_hash: spec.content_hash },
    approved_at: now(),
    carried_from: null,
    auto_commit: autoCommit === true,
  };
  writeJson(path.join(runDir, 'approvals', 'plan.json'), doc);
  let status = null;
  if (manifest.modifiers && manifest.modifiers.plan_only === true && manifest.status === 'awaiting_user') {
    manifest.status = 'active';
    writeManifest(runDir, manifest);
    status = 'active';
  }
  return { revision, auto_commit: doc.auto_commit, status };
}

module.exports = {
  PLAN_KEYS,
  readPlanApproval,
  checkPlan,
  writePlan,
  approvePlan,
  applyPlanOnlyStop,
};
