'use strict';

const fs = require('fs');
const path = require('path');
const { stripFrontmatter, parseItems } = require('./spec');

function flagTrue(value) {
  return value === true || value === 'true';
}

function loadReview(runDir, kind, revision) {
  const rel = `review/${kind}-r${revision}.md`;
  const empty = { exists: false, rel, fields: {}, verdict: '', findings: [] };
  if (!revision) return empty;
  const file = path.join(runDir, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return empty;
  const raw = fs.readFileSync(file, 'utf8');
  const { fields, body } = stripFrontmatter(raw);
  if (fields.artifact !== kind) return empty;
  if (fields.revision !== undefined && fields.revision !== '' && Number(fields.revision) !== revision) {
    return empty;
  }
  const verdict = fields.verdict || '';
  const findings = parseItems(body).filter((item) => (
    item.blocking !== undefined || /^F-[1-9][0-9]*$/.test(item.id || '')
  ));
  return { exists: true, rel, fields, verdict, findings };
}

function unresolvedBlocking(findings) {
  return findings.filter((item) => flagTrue(item.blocking) && !flagTrue(item.resolved));
}

module.exports = { flagTrue, loadReview, unresolvedBlocking };
