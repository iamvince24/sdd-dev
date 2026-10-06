'use strict';

const fs = require('fs');
const path = require('path');
const { UsageError, BlockedError } = require('./errors');
const { readJson, writeJson } = require('./fsutil');
const { contentHash } = require('./hash');
const { computeCodebase, sameRef } = require('./codebase');
const { readCurrentSpec, currentSpecApproval, stripFrontmatter, sectionMap, parseItems } = require('./spec');
const { readTasks, readVerification, currentPlanRevision, splitIds, splitPaths } = require('./plan');

const TOOL_ROOT = path.join(__dirname, '..');
const ROLES = ['scout', 'planner', 'plan-reviewer', 'executor', 'security-reviewer', 'verifier'];

function item(slot, filePath, revision, id, codebaseRef) {
  return {
    slot,
    path: filePath,
    revision: revision == null ? null : revision,
    id: id == null ? null : String(id),
    codebase_ref: codebaseRef || null,
  };
}

function sameCodebase(left, right) {
  if (!left && !right) return true;
  return sameRef(left, right);
}

function fileId(abs) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return 'missing';
  return contentHash(fs.readFileSync(abs));
}

function digest(value) {
  return contentHash(Buffer.from(JSON.stringify(value == null ? null : value)));
}

function readManifest(runDir) {
  const file = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(file)) throw new BlockedError('missing manifest.json');
  return readJson(file);
}

function primaryRef(repoRoot, manifest) {
  const workspace = (manifest.workspaces || [])[0];
  if (!workspace) return null;
  return computeCodebase(repoRoot, workspace.path || '.').codebase_ref;
}

function workspaceDoc(configDir) {
  const file = path.join(configDir, 'workspaces.json');
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function specPointer(runDir) {
  const spec = readCurrentSpec(runDir);
  if (!spec.ok) return null;
  return { path: 'spec/execution-spec.md', revision: spec.revision, id: spec.content_hash };
}

function planPointer(runDir) {
  const revision = currentPlanRevision(runDir);
  const file = path.join(runDir, 'plan', 'plan.md');
  if (!revision || !fs.existsSync(file)) return null;
  return { path: 'plan/plan.md', revision, id: contentHash(fs.readFileSync(file)) };
}

function markedItems(runDir, rel, section) {
  const abs = path.join(runDir, rel);
  if (!fs.existsSync(abs)) return [];
  const { body } = stripFrontmatter(fs.readFileSync(abs, 'utf8'));
  const map = sectionMap(body).map;
  return parseItems(section ? map.get(section) : body);
}

function commonItems(repoRoot, runDir, configDir, manifest, ref) {
  const items = [];
  const doc = workspaceDoc(configDir);
  for (const workspace of (doc && doc.workspaces) || []) {
    for (const convention of workspace.conventions || []) {
      items.push(item(`convention:${convention}`, convention, null, fileId(path.join(repoRoot, convention)), ref));
    }
  }
  const profile = path.join(configDir, 'workspaces.json');
  const profileRel = path.relative(repoRoot, profile).split(path.sep).join('/');
  items.push(item('profile', profileRel, null, fileId(profile), ref));
  items.push(item('write_roots', 'manifest.json', null, digest(manifest.write_roots || []), ref));
  items.push(item('grants', 'manifest.json', null, digest(manifest.grants || []), ref));
  items.push(item('capability_limits', 'manifest.json', null, digest(manifest.capability_limits || []), ref));
  items.push(item('modifiers', 'manifest.json', null, digest(manifest.modifiers || {}), ref));
  for (const rel of ['clarify/state.md', 'clarify/decisions.md']) {
    for (const entry of markedItems(runDir, rel)) {
      if (entry.limit !== 'true' && entry.kind !== 'limit') continue;
      items.push(item(`limit:${entry.id || rel}`, rel, null, entry.id || 'limit', ref));
    }
  }
  return items;
}

function formalReports(runDir, ref) {
  const items = [];
  const report = path.join(runDir, 'report.md');
  if (fs.existsSync(report)) items.push(item('report', 'report.md', null, fileId(report), ref));
  const dir = path.join(runDir, 'review');
  if (!fs.existsSync(dir)) return items;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^(plan-review|result-review)-r\d+\.md$/.test(name)) continue;
    const rel = `review/${name}`;
    items.push(item(`report:${name}`, rel, null, fileId(path.join(runDir, rel)), ref));
  }
  return items;
}

function prepareItem(runDir, ref) {
  const dir = path.join(runDir, 'review');
  if (!fs.existsSync(dir)) return null;
  const versions = fs.readdirSync(dir).map((name) => {
    const match = name.match(/^prepare-v([1-9][0-9]*)\.json$/);
    return match ? { name, version: Number(match[1]) } : null;
  }).filter(Boolean).sort((a, b) => b.version - a.version);
  if (!versions.length) return null;
  const rel = `review/${versions[0].name}`;
  return item('prepare', rel, versions[0].version, fileId(path.join(runDir, rel)), ref);
}

function resultBindingItem(runDir, ref) {
  const revision = currentPlanRevision(runDir);
  if (!revision) return null;
  const rel = `review/result-review-r${revision}.binding.json`;
  const abs = path.join(runDir, rel);
  return fs.existsSync(abs) && fs.statSync(abs).isFile()
    ? item('result-binding', rel, revision, fileId(abs), ref) : null;
}

function roleItems(repoRoot, runDir, manifest, ref, role, taskId) {
  const items = [];
  const spec = specPointer(runDir);
  const plan = planPointer(runDir);
  const includeSpec = spec && (manifest.route !== 'full_pipeline' || currentSpecApproval(runDir).ok);
  if (role === 'scout') {
    for (const source of manifest.sources || []) {
      items.push(item(`source:${source.path}`, source.path, null, source.id || 'missing', ref));
    }
    items.push(item('clarify-state', 'clarify/state.md', null, fileId(path.join(runDir, 'clarify', 'state.md')), ref));
    for (const entry of markedItems(runDir, 'clarify/state.md', 'unknown')) {
      if (entry.id) items.push(item(`unknown:${entry.id}`, 'clarify/state.md', null, entry.id, ref));
    }
    const workspace = (manifest.workspaces || [])[0];
    const baseline = workspace && workspace.baseline && workspace.baseline.codebase_ref;
    items.push(item('baseline', 'manifest.json', null, (workspace && workspace.id) || 'baseline', baseline || null));
  }
  if (role === 'planner') {
    if (includeSpec) {
      items.push(item('spec', spec.path, spec.revision, spec.id, ref));
      items.push(item('interfaces', spec.path, spec.revision, 'interfaces', ref));
    }
    items.push(item('clarify-state', 'clarify/state.md', null, fileId(path.join(runDir, 'clarify', 'state.md')), ref));
    items.push(item('clarify-decisions', 'clarify/decisions.md', null, fileId(path.join(runDir, 'clarify', 'decisions.md')), ref));
  }
  if (role === 'plan-reviewer') {
    if (includeSpec) items.push(item('spec', spec.path, spec.revision, spec.id, ref));
    if (plan) items.push(item('plan', plan.path, plan.revision, plan.id, ref));
    items.push(item('dimensions', 'review/dimensions.md', null, fileId(path.join(runDir, 'review', 'dimensions.md')), ref));
    if (includeSpec) items.push(item('constraints', spec.path, spec.revision, 'constraints', ref));
    const workspace = (manifest.workspaces || [])[0];
    if (workspace) items.push(item(`codebase:${workspace.id}`, workspace.path || '.', null, workspace.id, ref));
    items.push(...formalReports(runDir, ref));
  }
  if (role === 'executor') {
    const task = readTasks(runDir).find((entry) => entry.id === taskId);
    if (!task) throw new BlockedError(`${taskId} is not a task`);
    const revision = plan ? plan.revision : null;
    items.push(item('task', 'plan/plan.md', revision, task.id, ref));
    if (includeSpec) items.push(item('spec', spec.path, spec.revision, spec.id, ref));
    for (const ac of splitIds(task.acceptance)) {
      items.push(item(`acceptance:${ac}`, 'spec/execution-spec.md', spec && spec.revision, ac, ref));
      const method = readVerification(runDir).find((entry) => entry.id === ac);
      items.push(item(`verify:${ac}`, 'plan/plan.md', revision, (method && method.method) || ac, ref));
    }
    for (const file of splitPaths(task.paths)) items.push(item(`path:${file}`, file, revision, task.id, ref));
    for (const dep of splitIds(task.depends)) items.push(item(`depends:${dep}`, 'plan/plan.md', revision, dep, ref));
  }
  if (role === 'security-reviewer') {
    for (const entry of markedItems(runDir, 'spec/execution-spec.md', 'requirements')) {
      if (/^R-[1-9][0-9]*$/.test(entry.id || '')) {
        items.push(item(`requirement:${entry.id}`, 'spec/execution-spec.md', spec && spec.revision, entry.id, ref));
      }
    }
    if (plan) {
      items.push(item('decisions', plan.path, plan.revision, 'decisions', ref));
      items.push(item('interfaces', plan.path, plan.revision, 'interfaces', ref));
    }
    items.push(item('diff', 'manifest.json', null, 'diff', ref));
    items.push(item('evidence', 'evidence', null, 'evidence', ref));
    items.push(...formalReports(runDir, ref));
    const prepare = prepareItem(runDir, ref);
    if (prepare) items.push(prepare);
    const binding = resultBindingItem(runDir, ref);
    if (binding) items.push(binding);
  }
  if (role === 'verifier') {
    for (const entry of markedItems(runDir, 'spec/execution-spec.md', 'acceptance')) {
      if (/^AC-[1-9][0-9]*$/.test(entry.id || '')) {
        items.push(item(`acceptance:${entry.id}`, 'spec/execution-spec.md', spec && spec.revision, entry.id, ref));
      }
    }
    items.push(item('diff', 'manifest.json', null, 'diff', ref));
    items.push(item('evidence', 'evidence', null, 'evidence', ref));
    items.push(...formalReports(runDir, ref));
    const prepare = prepareItem(runDir, ref);
    if (prepare) items.push(prepare);
    const binding = resultBindingItem(runDir, ref);
    if (binding) items.push(binding);
  }
  return items;
}

function buildItems(repoRoot, runDir, configDir, role, taskId) {
  const manifest = readManifest(runDir);
  const ref = primaryRef(repoRoot, manifest);
  return [
    ...commonItems(repoRoot, runDir, configDir, manifest, ref),
    ...roleItems(repoRoot, runDir, manifest, ref, role, taskId),
  ];
}

function contextFile(role, taskId) {
  return taskId ? `context/${role}-${taskId}.json` : `context/${role}.json`;
}

function writeContext(repoRoot, runDir, configDir, role, taskId) {
  if (!ROLES.includes(role)) throw new UsageError(`--role must be ${ROLES.join(', ')}`);
  if (role === 'executor' && !taskId) throw new UsageError('--task is required for executor');
  if (taskId && !/^T-[1-9][0-9]*$/.test(taskId)) throw new UsageError('--task must be T-n');
  if (role === 'plan-reviewer') {
    const src = path.join(TOOL_ROOT, 'templates', 'review', 'dimensions.md');
    const dest = path.join(runDir, 'review', 'dimensions.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  const rel = contextFile(role, taskId);
  const doc = {
    role,
    task: taskId || null,
    context_id: taskId ? `${role}:${taskId}` : role,
    stale: false,
    items: buildItems(repoRoot, runDir, configDir, role, taskId),
  };
  const abs = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  writeJson(abs, doc);
  return { ...doc, rel };
}

function sameItems(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const fresh = new Map(right.map((entry) => [entry.slot, entry]));
  for (const entry of left) {
    const other = fresh.get(entry.slot);
    if (!other) return false;
    if (entry.path !== other.path || entry.revision !== other.revision || entry.id !== other.id) return false;
    if (!sameCodebase(entry.codebase_ref, other.codebase_ref)) return false;
  }
  return true;
}

function refreshContexts(repoRoot, runDir, configDir) {
  const dir = path.join(runDir, 'context');
  if (!fs.existsSync(dir)) return [];
  const stale = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const abs = path.join(dir, name);
    const doc = readJson(abs);
    if (!doc || !ROLES.includes(doc.role)) continue;
    const fresh = buildItems(repoRoot, runDir, configDir, doc.role, doc.task || null);
    const drifted = !sameItems(doc.items, fresh);
    if (drifted && doc.stale !== true) {
      doc.stale = true;
      writeJson(abs, doc);
    }
    if (doc.stale === true || drifted) stale.push(doc.task ? `${doc.role}-${doc.task}` : doc.role);
  }
  return stale;
}

module.exports = { ROLES, writeContext, refreshContexts, buildItems };
