'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./fsutil');
const { contentHash } = require('./hash');
const { computeCodebase, sameRef } = require('./codebase');
const { parseFrontmatter, approvalRevisionPath, revisionFiles } = require('./revision');

function sourceAbs(repoRoot, runDir, source) {
  if (source.origin === 'stdin') return path.join(runDir, source.path);
  return path.join(repoRoot, source.path);
}

function diffSources(repoRoot, runDir, sources) {
  const rows = [];
  const drifted = new Map();
  for (const source of sources || []) {
    const abs = sourceAbs(repoRoot, runDir, source);
    let current = 'missing';
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) current = contentHash(fs.readFileSync(abs));
    if (current === source.id) continue;
    rows.push({ path: source.path, previous: source.id, current });
    drifted.set(source.path, current === 'missing' ? null : current);
  }
  return { rows, drifted };
}

function affectedRevisions(runDir, drifted) {
  const hits = [];
  for (const rel of revisionFiles(runDir)) {
    const parsed = parseFrontmatter(fs.readFileSync(path.join(runDir, rel), 'utf8'));
    const cited = (parsed.source_refs || []).some((ref) => drifted.has(ref.path) && ref.id !== drifted.get(ref.path));
    if (cited) hits.push(rel);
  }
  return hits;
}

function affectedApprovals(runDir, revisionRels) {
  const targets = new Set(revisionRels);
  const dir = path.join(runDir, 'approvals');
  if (!fs.existsSync(dir)) return [];
  const hits = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    let doc;
    try {
      doc = readJson(path.join(dir, name));
    } catch {
      continue;
    }
    const rel = approvalRevisionPath(doc);
    const based = doc.based_on_spec && Number.isInteger(doc.based_on_spec.revision)
      ? `spec/revisions/r${doc.based_on_spec.revision}.md`
      : null;
    if ((rel && targets.has(rel)) || (based && targets.has(based))) hits.push(`approvals/${name}`);
  }
  return hits;
}

function markStaleEvidence(runDir, observations) {
  const byId = new Map(observations.map((item) => [item.ws.id, item.current.codebase_ref]));
  const root = path.join(runDir, 'evidence');
  if (!fs.existsSync(root)) return [];
  const stale = [];
  for (const name of fs.readdirSync(root).sort()) {
    const metaPath = path.join(root, name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = readJson(metaPath);
    const current = byId.get(meta.workspace) || (observations[0] && observations[0].current.codebase_ref);
    const fresh = sameRef(meta.codebase_ref, current);
    meta.stale = !fresh;
    meta.stale_reason = fresh ? null : 'codebase_ref';
    writeJson(metaPath, meta);
    if (!fresh) stale.push(meta.ac || name);
  }
  return stale;
}

// Writes evidence meta.json. Does not modify approvals or workspace baselines.
function refresh(repoRoot, runDir, manifest, { includeSources }) {
  const observations = (manifest.workspaces || []).map((ws) => ({
    ws,
    current: computeCodebase(repoRoot, ws.path || '.'),
  }));
  const stale = markStaleEvidence(runDir, observations);
  let sources = [];
  let revisions = [];
  let approvals = [];
  if (includeSources) {
    const diff = diffSources(repoRoot, runDir, manifest.sources);
    sources = diff.rows;
    revisions = affectedRevisions(runDir, diff.drifted);
    approvals = affectedApprovals(runDir, revisions);
  }
  return {
    workspaces: observations.map(({ ws, current }) => ({
      id: ws.id,
      baseline_head: ws.baseline.codebase_ref.head,
      current_head: current.codebase_ref.head,
      baseline_worktree_hash: ws.baseline.codebase_ref.worktree_hash,
      current_worktree_hash: current.codebase_ref.worktree_hash,
    })),
    sources,
    revisions,
    approvals,
    stale_evidence: stale,
  };
}

module.exports = { refresh };
