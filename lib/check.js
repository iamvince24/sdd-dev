'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./fsutil');
const { revisionHash, approvalRevisionPath } = require('./revision');

// Read-only. A mismatched frozen revision fails; approval JSON is not rewritten.
function checkRun(runDir, runId) {
  const problems = [];
  const dir = path.join(runDir, 'approvals');
  if (!fs.existsSync(dir)) return problems;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const rel = `approvals/${name}`;
    const abs = path.join(dir, name);
    let doc;
    try {
      doc = readJson(abs);
    } catch (error) {
      problems.push(`${runId} ${rel}: ${error.message}`);
      continue;
    }
    const target = approvalRevisionPath(doc);
    if (!target) {
      problems.push(`${runId} ${rel}: artifact/revision is not a frozen revision`);
      continue;
    }
    if (typeof doc.content_hash !== 'string' || !doc.content_hash) {
      problems.push(`${runId} ${rel}: missing content_hash`);
      continue;
    }
    const file = path.join(runDir, target);
    if (!fs.existsSync(file)) {
      problems.push(`${runId} ${rel}: ${target} missing`);
      continue;
    }
    const actual = revisionHash(fs.readFileSync(file));
    if (actual !== doc.content_hash) problems.push(`${runId} ${rel}: ${target} hash mismatch`);
  }
  return problems;
}

module.exports = { checkRun };
