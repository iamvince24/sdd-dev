'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { computeCodebase, sameRef } = require('./codebase');
const { BlockedError } = require('./errors');
const { isInside } = require('./fsutil');
const { contentHash } = require('./hash');

function streamHash(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest('hex')}`;
}

function workspaceBindings(repoRoot, manifest) {
  const list = manifest && manifest.workspaces;
  if (!Array.isArray(list) || !list.length) throw new BlockedError('review has no workspaces');
  return list.map((workspace) => {
    if (!workspace || !workspace.id) throw new BlockedError('review workspace id is missing');
    const rel = workspace.path || '.';
    const state = computeCodebase(repoRoot, rel);
    const unknown_hashes = (state.codebase_ref.unknown || []).map((item) => {
      const file = path.join(repoRoot, item.path);
      try {
        if (!isInside(fs.realpathSync(file), fs.realpathSync(repoRoot))) throw new Error('outside repository');
        if (!fs.statSync(file).isFile()) throw new Error('not a file');
        return { path: item.path, hash: streamHash(file) };
      } catch (error) {
        throw new BlockedError(`cannot fingerprint ${item.path}: ${error.message}`);
      }
    });
    return { id: workspace.id, path: rel, codebase_ref: state.codebase_ref, unknown_hashes };
  });
}

function evidenceBindings(runDir) {
  const evidenceRoot = path.join(runDir, 'evidence');
  if (!fs.existsSync(evidenceRoot)) return [];
  const files = [];
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new BlockedError(`evidence/${rel} is a symbolic link`);
      if (entry.isDirectory()) visit(path.join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
      else throw new BlockedError(`evidence/${rel} is not a regular file`);
    }
  }
  visit(evidenceRoot, '');
  return files.map((rel) => {
    const abs = path.join(evidenceRoot, rel);
    return { path: `evidence/${rel}`, hash: streamHash(abs) };
  });
}

function captureReviewBinding(repoRoot, runDir, manifest) {
  return {
    version: 1,
    workspaces: workspaceBindings(repoRoot, manifest),
    evidence: evidenceBindings(runDir),
  };
}

function bindingHash(binding) {
  return contentHash(Buffer.from(JSON.stringify(binding)));
}

function bindingProblems(repoRoot, runDir, manifest, binding) {
  if (!binding || binding.version !== 1 || !Array.isArray(binding.workspaces) || !Array.isArray(binding.evidence)) {
    return ['審查版本綁定缺失或格式無效'];
  }
  let current;
  try {
    current = captureReviewBinding(repoRoot, runDir, manifest);
  } catch (error) {
    return [`審查版本無法確認：${error.message}`];
  }
  const problems = [];
  if (current.workspaces.length !== binding.workspaces.length) problems.push('工作區數量已變更');
  for (const stored of binding.workspaces) {
    if (!stored || typeof stored.id !== 'string' || !Array.isArray(stored.unknown_hashes)) {
      problems.push('工作區綁定格式無效');
      continue;
    }
    const fresh = current.workspaces.find((item) => item.id === stored.id);
    if (!fresh || fresh.path !== stored.path || !sameRef(stored.codebase_ref, fresh.codebase_ref)
      || JSON.stringify(stored.unknown_hashes) !== JSON.stringify(fresh.unknown_hashes)) {
      problems.push(`工作區 ${stored.id || '?'} 成果已變更或無法確認`);
    }
  }
  if (JSON.stringify(binding.evidence) !== JSON.stringify(current.evidence)) problems.push('驗收證據已變更');
  return problems;
}

function reviewBindingProblems(repoRoot, runDir, review, manifest) {
  if (!review || !review.exists) return [];
  const rel = review.rel;
  const marker = review.fields && review.fields.binding_hash;
  if (!marker) return [`${rel}: 未確認審查版本（缺少成果綁定）`];
  const sidecar = path.join(runDir, rel.replace(/\.md$/, '.binding.json'));
  let binding;
  try {
    binding = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  } catch (error) {
    return [`${rel}: 無法讀取成果綁定：${error.message}`];
  }
  if (bindingHash(binding) !== marker) return [`${rel}: 成果綁定 hash 不符`];
  return bindingProblems(repoRoot, runDir, manifest, binding).map((issue) => `${rel}: ${issue}`);
}

module.exports = { streamHash, captureReviewBinding, bindingHash, bindingProblems, reviewBindingProblems };
