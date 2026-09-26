'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UsageError, BlockedError } = require('./errors');
const { readJson, writeJson, isInside, toPosix, now } = require('./fsutil');
const { computeCodebase } = require('./codebase');
const { save } = require('./manifest');
const { resolveRepo, repoPaths } = require('./repo');
const { requireInstall } = require('./install');

const ROUTES = {
  direct: 'direct',
  selected_advisors: 'selected_advisors',
  full_pipeline: 'full_pipeline',
  ag: 'full_pipeline',
  agentflow: 'full_pipeline',
};

function assertSafeId(id, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id || '')) throw new UsageError(`bad ${label}: ${id}`);
}

function openInstalled(repoValue) {
  const repo = resolveRepo(repoValue);
  const paths = repoPaths(repo.root);
  requireInstall(paths);
  return { repo, paths };
}

function runDirectory(paths, id) {
  return path.join(paths.runs, id);
}

function listRunIds(paths) {
  if (!fs.existsSync(paths.runs)) return [];
  return fs.readdirSync(paths.runs)
    .filter((name) => fs.existsSync(path.join(paths.runs, name, 'manifest.json')))
    .sort();
}

function resolveRunId(paths, requested) {
  if (requested) {
    assertSafeId(requested, 'run id');
    if (!fs.existsSync(path.join(runDirectory(paths, requested), 'manifest.json'))) {
      throw new BlockedError(`run not found: ${requested}`);
    }
    return requested;
  }
  const ids = listRunIds(paths);
  if (ids.length === 1) return ids[0];
  if (!ids.length) throw new BlockedError('no runs; use `sdd run start`');
  throw new UsageError('multiple runs; pass --run <id>');
}

function readManifest(paths, id) {
  try {
    return readJson(path.join(runDirectory(paths, id), 'manifest.json'));
  } catch (error) {
    throw new BlockedError(`cannot parse ${id}/manifest.json: ${error.message}`);
  }
}

function writeManifest(paths, id, manifest) {
  save(runDirectory(paths, id), manifest);
}

function dayStamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function newRunId(runsDir, date = new Date()) {
  const day = dayStamp(date);
  fs.mkdirSync(runsDir, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `${day}-${crypto.randomBytes(2).toString('hex')}`;
    if (!fs.existsSync(path.join(runsDir, id))) return id;
  }
  throw new BlockedError('could not allocate run_id');
}

function ensureWorkspace(paths, repo, id) {
  assertSafeId(id, 'workspace id');
  const file = path.join(paths.config, 'workspaces.json');
  if (!fs.existsSync(file)) {
    const stub = { id, path: '.', vcs: repo.vcs };
    writeJson(file, { workspaces: [stub] });
    return stub;
  }
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse workspaces.json: ${error.message}`);
  }
  if (!doc || !Array.isArray(doc.workspaces)) throw new BlockedError('workspaces.json must contain workspaces[]');
  const found = doc.workspaces.find((item) => item && item.id === id);
  if (found) return found;
  const stub = { id, path: '.', vcs: repo.vcs };
  doc.workspaces.push(stub);
  writeJson(file, doc);
  return stub;
}

function workspaceLocation(repoRoot, workspace) {
  const rel = toPosix(workspace.path || '.');
  const abs = path.resolve(repoRoot, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new BlockedError(`workspace path is not a directory: ${rel}`);
  }
  const realRoot = fs.realpathSync(repoRoot);
  if (!isInside(fs.realpathSync(abs), realRoot)) throw new BlockedError(`workspace path escapes the repo: ${rel}`);
  return rel;
}

function readOptionalJson(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse ${label}: ${error.message}`);
  }
}

function readModels(configDir) {
  const value = readOptionalJson(path.join(configDir, 'models.json'), 'models.json');
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new BlockedError('models.json must be an object');
  return value;
}

function readPolicyVersion(configDir) {
  const value = readOptionalJson(path.join(configDir, 'policy.json'), 'policy.json');
  if (value == null) return 'absent';
  if (typeof value.version === 'string' && value.version) return value.version;
  if (typeof value.policy_version === 'string' && value.policy_version) return value.policy_version;
  return 'absent';
}

function resolveSource(repoRoot, input) {
  const candidates = path.isAbsolute(input)
    ? [input]
    : [path.resolve(repoRoot, input), path.resolve(process.cwd(), input)];
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) throw new BlockedError(`source not found: ${input}`);
  const realRoot = fs.realpathSync(repoRoot);
  const real = fs.realpathSync(found);
  if (!isInside(real, realRoot)) throw new BlockedError(`source must be inside the repo: ${input}`);
  return { abs: real, rel: toPosix(path.relative(realRoot, real)) };
}

function nextSourceName(dir) {
  const sources = path.join(dir, 'sources');
  fs.mkdirSync(sources, { recursive: true });
  const taken = new Set(fs.readdirSync(sources));
  let n = 1;
  while (taken.has(`${n}.md`)) n += 1;
  return `sources/${n}.md`;
}

function modifiersFrom(input) {
  const src = input || {};
  return {
    fast_lane: src.fast_lane === true,
    cross_check: src.cross_check === true,
    no_delegation: src.no_delegation === true,
    plan_only: src.plan_only === true,
  };
}

function buildManifest({ id, route, reason, repo, paths, workspace, sources, modifiers }) {
  const rel = workspaceLocation(repo.root, workspace);
  const captured = computeCodebase(repo.root, rel);
  const mods = modifiersFrom(modifiers);
  return {
    run_id: id,
    policy_version: readPolicyVersion(paths.config),
    route,
    route_history: [{ at: now(), route, modifiers: modifiersFrom(mods), reason, by: 'user' }],
    modifiers: mods,
    platform: 'unknown',
    models: readModels(paths.config),
    sources,
    workspaces: [{
      id: workspace.id,
      path: rel,
      vcs: captured.vcs,
      baseline: {
        branch: captured.branch,
        codebase_ref: captured.codebase_ref,
        dirty: captured.dirty,
      },
    }],
    write_roots: [`.sdd-dev/runs/${id}/`],
    grants: [],
    capability_limits: [],
    implementation_authorized: false,
    status: 'active',
    blocks: [],
    drift: null,
  };
}

module.exports = {
  ROUTES,
  assertSafeId,
  openInstalled,
  runDirectory,
  listRunIds,
  resolveRunId,
  readManifest,
  writeManifest,
  newRunId,
  ensureWorkspace,
  resolveSource,
  nextSourceName,
  modifiersFrom,
  buildManifest,
};
