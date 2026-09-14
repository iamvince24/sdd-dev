'use strict';

const fs = require('fs');
const path = require('path');
const { TOOL_ROOT, loadConfig, resolveRepoRoot } = require('./config');

const STATE_ROOT = path.join(TOOL_ROOT, 'state');

function usageError(message, code = 'INVALID_ARGUMENT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateRepoId(repoId) {
  if (!repoId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoId)) {
    throw usageError(`Invalid repo id: ${repoId || '(empty)'}`);
  }
  return repoId;
}

function validateItem(item) {
  if (!item || path.isAbsolute(item)) throw usageError(`Invalid item path: ${item || '(empty)'}`);
  const normalized = item.split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
  const parts = normalized.split('/');
  if (!normalized || parts.some((part) => !part || part === '.' || part === '..')) {
    throw usageError(`Invalid item path: ${item}`);
  }
  return normalized;
}

function projectContext(repoId, options = {}) {
  validateRepoId(repoId);
  const config = options.config || loadConfig();
  const entry = config.projects[repoId];
  if (!entry || !entry.repoRoot) throw usageError(`Repository is not registered: ${repoId}`, 'REPO_NOT_REGISTERED');
  const repoRoot = resolveRepoRoot(entry);
  const projectStateRoot = path.join(STATE_ROOT, 'projects', repoId);
  return { toolRoot: TOOL_ROOT, stateRoot: STATE_ROOT, repoId, repoRoot, projectStateRoot, config, entry };
}

function itemContext(repoId, item, options = {}) {
  const context = projectContext(repoId, options);
  const itemKey = validateItem(item);
  const itemDir = path.join(context.projectStateRoot, 'active', ...itemKey.split('/'));
  const relative = path.relative(path.join(context.projectStateRoot, 'active'), itemDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw usageError('Item path escapes active state');
  if (options.mustExist !== false && !fs.existsSync(path.join(itemDir, '00-spec.md'))) {
    throw usageError(`Item does not exist or has no 00-spec.md: ${repoId}/${itemKey}`, 'ITEM_NOT_FOUND');
  }
  return { ...context, itemKey, itemDir };
}

function repoIdForRoot(repoRoot, config = loadConfig()) {
  const wanted = fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : path.resolve(repoRoot);
  const matches = Object.entries(config.projects).filter(([, entry]) => {
    const candidate = resolveRepoRoot(entry);
    const resolved = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
    return resolved === wanted;
  });
  if (matches.length !== 1) {
    throw usageError(
      matches.length === 0 ? `Repository root is not registered: ${repoRoot}` : `Repository root is registered more than once: ${repoRoot}`,
      matches.length === 0 ? 'REPO_NOT_REGISTERED' : 'DUPLICATE_REPO'
    );
  }
  return matches[0][0];
}

module.exports = { STATE_ROOT, usageError, validateRepoId, validateItem, projectContext, itemContext, repoIdForRoot };
