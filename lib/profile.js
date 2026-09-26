'use strict';

const fs = require('fs');
const path = require('path');
const { UsageError, BlockedError } = require('./errors');
const { readJson, writeJson, isInside, toPosix, now } = require('./fsutil');
const { assertSafeId } = require('./runstore');

const VERIFY_IDS = ['lint', 'type', 'unit', 'integration', 'e2e', 'build'];
const CONVENTION_FILES = ['AGENTS.md', 'CONTRIBUTING.md', '.editorconfig'];
const REASONS = {
  lint: 'no lint command',
  type: 'no typecheck command',
  unit: 'no unit test command',
  integration: 'no integration command',
  e2e: 'no e2e command',
  build: 'no build command',
};

const PACKAGE_SCRIPTS = [
  ['test', 'unit', 'npm test'],
  ['lint', 'lint', 'npm run lint'],
  ['typecheck', 'type', 'npm run typecheck'],
  ['build', 'build', 'npm run build'],
  ['e2e', 'e2e', 'npm run e2e'],
  ['integration', 'integration', 'npm run integration'],
];

function workspacesFile(paths) {
  return path.join(paths.config, 'workspaces.json');
}

function loadDoc(paths) {
  const file = workspacesFile(paths);
  if (!fs.existsSync(file)) return { workspaces: [] };
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse workspaces.json: ${error.message}`);
  }
  if (!doc || !Array.isArray(doc.workspaces)) throw new BlockedError('workspaces.json must contain workspaces[]');
  return doc;
}

function saveDoc(paths, doc) {
  writeJson(workspacesFile(paths), doc);
}

function workspaceDir(repoRoot, rel) {
  return path.resolve(repoRoot, !rel || rel === '.' ? '.' : rel);
}

function readPackage(dir) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new BlockedError(`cannot parse package.json: ${error.message}`);
  }
}

function assign(found, id, command) {
  if (!found[id]) found[id] = command;
}

function fromPackage(dir, found) {
  const doc = readPackage(dir);
  if (!doc) return;
  const scripts = doc.scripts && typeof doc.scripts === 'object' ? doc.scripts : {};
  for (const [key, id, command] of PACKAGE_SCRIPTS) {
    if (typeof scripts[key] === 'string' && scripts[key].trim()) assign(found, id, command);
  }
}

function fromPyproject(dir, found) {
  const file = path.join(dir, 'pyproject.toml');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (/^\s*\[tool\.pytest(?:\.ini_options)?\]\s*$/m.test(text)) assign(found, 'unit', 'pytest');
}

function fromCargo(dir, found) {
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) assign(found, 'unit', 'cargo test');
}

function fromGo(dir, found) {
  if (fs.existsSync(path.join(dir, 'go.mod'))) assign(found, 'unit', 'go test ./...');
}

function makefileTargets(text) {
  const targets = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#') || line.startsWith('\t')) continue;
    if (/^[A-Za-z0-9_./-]+\s*[:?+]?=/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_./-]+(?:\s+[A-Za-z0-9_./-]+)*)\s*:/);
    if (!match) continue;
    for (const name of match[1].split(/\s+/)) targets.add(name);
  }
  return targets;
}

function fromMakefile(dir, found) {
  const file = path.join(dir, 'Makefile');
  if (!fs.existsSync(file)) return;
  const targets = makefileTargets(fs.readFileSync(file, 'utf8'));
  if (targets.has('test')) assign(found, 'unit', 'make test');
  if (targets.has('lint')) assign(found, 'lint', 'make lint');
}

function detectCommands(dir) {
  const found = {};
  fromPackage(dir, found);
  fromPyproject(dir, found);
  fromCargo(dir, found);
  fromGo(dir, found);
  fromMakefile(dir, found);
  return found;
}

function verifySlot(id, command) {
  const absent = !command;
  return {
    id,
    command: command || null,
    cwd: '.',
    requires: [],
    outputs: [],
    limitation: null,
    known_failures: [],
    absent,
    reason: absent ? REASONS[id] : null,
  };
}

function detectVerify(dir) {
  const found = detectCommands(dir);
  return VERIFY_IDS.map((id) => verifySlot(id, found[id] || null));
}

function conventionsOf(repoRoot, rel) {
  const dir = workspaceDir(repoRoot, rel);
  const prefix = !rel || rel === '.' ? '' : `${rel}/`;
  const found = [];
  for (const name of CONVENTION_FILES) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) found.push(`${prefix}${name}`);
  }
  return found;
}

function versioningOf(dir) {
  const doc = readPackage(dir);
  if (doc && typeof doc.version === 'string' && doc.version) return 'package.json';
  return 'none';
}

function commandOf(slot) {
  if (!slot || slot.absent === true) return null;
  if (typeof slot.command !== 'string' || !slot.command.trim()) return null;
  return slot.command;
}

function resolveWorkspacePath(repoRoot, input) {
  if (!input) throw new UsageError('--path is required');
  const abs = path.resolve(repoRoot, input);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new BlockedError(`workspace path is not a directory: ${input}`);
  }
  const realRoot = fs.realpathSync(repoRoot);
  const real = fs.realpathSync(abs);
  if (!isInside(real, realRoot)) throw new BlockedError(`workspace path escapes the repo: ${input}`);
  const rel = toPosix(path.relative(realRoot, real));
  return rel || '.';
}

function blankEntry({ id, rel, stack, vcs, repoRoot }) {
  const dir = workspaceDir(repoRoot, rel);
  return {
    id,
    path: rel,
    vcs,
    stack,
    conventions: conventionsOf(repoRoot, rel),
    versioning: versioningOf(dir),
    profile_generated_at: now(),
    verify: detectVerify(dir),
  };
}

function keptSlot(prev, next) {
  return {
    id: next.id,
    command: next.command,
    cwd: prev.cwd != null && prev.cwd !== '' ? prev.cwd : next.cwd,
    requires: Array.isArray(prev.requires) ? prev.requires : [],
    outputs: Array.isArray(prev.outputs) ? prev.outputs : [],
    limitation: Object.prototype.hasOwnProperty.call(prev, 'limitation') ? prev.limitation : null,
    known_failures: Array.isArray(prev.known_failures) ? prev.known_failures : [],
    absent: next.absent,
    reason: next.reason,
  };
}

function mergeVerify(previous, detected) {
  const prevById = new Map();
  for (const slot of previous || []) {
    if (slot && slot.id) prevById.set(slot.id, slot);
  }
  return detected.map((next) => {
    const prev = prevById.get(next.id);
    if (!prev) return next;
    if (commandOf(prev) !== commandOf(next)) return next;
    return keptSlot(prev, next);
  });
}

function addWorkspace(paths, repo, { id, relPath, stack }) {
  assertSafeId(id, 'workspace id');
  if (stack == null || stack === '') throw new UsageError('--stack is required');
  const rel = resolveWorkspacePath(repo.root, relPath);
  const doc = loadDoc(paths);
  if (doc.workspaces.some((item) => item && item.id === id)) {
    throw new BlockedError(`workspace already exists: ${id}`);
  }
  const entry = blankEntry({ id, rel, stack, vcs: repo.vcs, repoRoot: repo.root });
  doc.workspaces.push(entry);
  saveDoc(paths, doc);
  return entry;
}

function refreshWorkspace(paths, repo, id) {
  assertSafeId(id, 'workspace id');
  const doc = loadDoc(paths);
  const entry = doc.workspaces.find((item) => item && item.id === id);
  if (!entry) throw new BlockedError(`workspace not found: ${id}`);
  const rel = entry.path || '.';
  resolveWorkspacePath(repo.root, rel);
  const dir = workspaceDir(repo.root, rel);
  entry.conventions = conventionsOf(repo.root, rel);
  entry.versioning = versioningOf(dir);
  entry.verify = mergeVerify(entry.verify, detectVerify(dir));
  entry.profile_generated_at = now();
  saveDoc(paths, doc);
  return entry;
}

// Fills verify[] once. An existing verify[] is left byte-for-byte alone when
// every detected command still matches. A changed command updates only that
// slot's command, absent, reason, and profile_generated_at.
function syncProfileOnStart(paths, repo, id) {
  const file = workspacesFile(paths);
  const doc = loadDoc(paths);
  const entry = doc.workspaces.find((item) => item && item.id === id);
  if (!entry) return null;
  const dir = workspaceDir(repo.root, entry.path || '.');
  const detected = detectVerify(dir);
  if (!Array.isArray(entry.verify)) {
    entry.conventions = conventionsOf(repo.root, entry.path || '.');
    entry.versioning = versioningOf(dir);
    entry.verify = detected;
    entry.profile_generated_at = now();
    saveDoc(paths, doc);
    return entry;
  }
  const byId = new Map();
  for (const slot of entry.verify) {
    if (slot && slot.id) byId.set(slot.id, slot);
  }
  let changed = false;
  for (const next of detected) {
    const prev = byId.get(next.id);
    if (!prev) {
      entry.verify.push(next);
      changed = true;
      continue;
    }
    if (commandOf(prev) !== commandOf(next)) {
      prev.command = next.command;
      prev.absent = next.absent;
      prev.reason = next.reason;
      changed = true;
    }
  }
  if (!changed) return entry;
  entry.profile_generated_at = now();
  saveDoc(paths, doc);
  return entry;
}

module.exports = {
  VERIFY_IDS,
  commandOf,
  addWorkspace,
  refreshWorkspace,
  syncProfileOnStart,
  workspacesFile,
};
