'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { readJson } = require('./fsutil');
const { TOOL_ROOT } = require('./tool');

function policyTemplatePath() {
  return path.join(TOOL_ROOT, 'templates', 'config', 'policy.json');
}

function defaultPolicy() {
  let doc;
  try {
    doc = readJson(policyTemplatePath());
  } catch (error) {
    throw new BlockedError(`cannot read policy template: ${error.message}`);
  }
  validatePolicy(doc);
  return {
    version: doc.version,
    max_revise_rounds: doc.max_revise_rounds,
    required_enforcement: doc.required_enforcement.slice(),
  };
}

function validatePolicy(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new BlockedError('policy.json must be an object');
  }
  if (doc.version !== undefined && (typeof doc.version !== 'string' || !doc.version)) {
    throw new BlockedError('policy.json version must be a non-empty string');
  }
  if (!Number.isInteger(doc.max_revise_rounds) || doc.max_revise_rounds < 0) {
    throw new BlockedError('policy.json max_revise_rounds must be a non-negative integer');
  }
  if (!Array.isArray(doc.required_enforcement)) {
    throw new BlockedError('policy.json required_enforcement must be a list');
  }
  for (const op of doc.required_enforcement) {
    if (typeof op !== 'string' || !op.trim()) {
      throw new BlockedError('policy.json required_enforcement must be a list of ops');
    }
  }
}

// Missing file keeps old installs runnable: two revise rounds, nothing required.
function readPolicy(configDir) {
  const file = path.join(configDir, 'policy.json');
  if (!fs.existsSync(file)) {
    return { version: 'absent', max_revise_rounds: 2, required_enforcement: [] };
  }
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse policy.json: ${error.message}`);
  }
  validatePolicy(doc);
  return doc;
}

module.exports = { defaultPolicy, readPolicy };
