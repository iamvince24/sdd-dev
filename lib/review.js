'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
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

const REVIEW_KINDS = { plan: 'plan-review', result: 'result-review' };
const VERDICTS = new Set(['READY', 'REVISE', 'BLOCKED']);
const REVIEWER_KINDS = new Set(['human', 'agent']);
const FINDING_FIELDS = ['location', 'basis', 'severity', 'suggestion', 'resolution', 'blocking'];

function unquote(value) {
  return String(value).trim().replace(/^["']|["']$/g, '');
}

function parseFindingText(text) {
  const findings = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const start = line.match(/^- ([a-z_]+):\s*(.*)$/);
    if (start) {
      if (start[1] !== 'id') throw new BlockedError('a finding must start with id');
      current = { id: unquote(start[2]) };
      findings.push(current);
      continue;
    }
    const cont = line.match(/^  ([a-z_]+):\s*(.*)$/);
    if (!cont || !current) throw new BlockedError(`finding line is not a field: ${line}`);
    if (Object.prototype.hasOwnProperty.call(current, cont[1])) {
      throw new BlockedError(`finding repeats ${cont[1]}`);
    }
    current[cont[1]] = unquote(cont[2]);
  }
  for (const finding of findings) {
    if (!/^F-[1-9][0-9]*$/.test(finding.id || '')) throw new BlockedError(`finding id is invalid: ${finding.id || ''}`);
    for (const key of FINDING_FIELDS) {
      if (!finding[key]) throw new BlockedError(`${finding.id} missing ${key}`);
    }
    if (finding.blocking !== 'true' && finding.blocking !== 'false') {
      throw new BlockedError(`${finding.id} blocking must be true or false`);
    }
    if (finding.resolved !== undefined && finding.resolved !== 'true' && finding.resolved !== 'false') {
      throw new BlockedError(`${finding.id} resolved must be true or false`);
    }
    const allowed = new Set(['id', ...FINDING_FIELDS, 'score', 'resolved']);
    for (const key of Object.keys(finding)) {
      if (!allowed.has(key)) throw new BlockedError(`${finding.id} has unknown field ${key}`);
    }
  }
  return findings;
}

function renderReview({ artifact, revision, verdict, reviewerKind, independent, contextId, findings }) {
  const lines = [
    '---',
    `artifact: ${artifact}`,
    `revision: ${revision}`,
    `verdict: ${verdict}`,
    `reviewer_kind: ${reviewerKind}`,
  ];
  if (independent === true) lines.push('independent: true');
  if (contextId) lines.push(`context_id: ${contextId}`);
  lines.push('---', '');
  for (const finding of findings) {
    lines.push(`- id: ${finding.id}`);
    for (const key of FINDING_FIELDS) lines.push(`  ${key}: ${finding[key]}`);
    if (finding.score !== undefined) lines.push(`  score: ${finding.score}`);
    if (finding.resolved !== undefined) lines.push(`  resolved: ${finding.resolved}`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

function writeReview(runDir, { kind, revision, verdict, reviewerKind, independent, contextId, text }) {
  const artifact = REVIEW_KINDS[kind];
  if (!artifact) throw new BlockedError('review kind must be plan or result');
  if (!VERDICTS.has(verdict)) throw new BlockedError('verdict must be READY, REVISE, or BLOCKED');
  if (!REVIEWER_KINDS.has(reviewerKind)) throw new BlockedError('reviewer_kind must be human or agent');
  if (!Number.isInteger(revision) || revision < 1) throw new BlockedError('review revision is missing');
  const findings = parseFindingText(text);
  const body = renderReview({
    artifact,
    revision,
    verdict,
    reviewerKind,
    independent: independent === true,
    contextId: contextId || '',
    findings,
  });
  const rel = `review/${artifact}-r${revision}.md`;
  const file = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { rel, revision, artifact, findings: findings.length };
}

module.exports = {
  flagTrue,
  loadReview,
  unresolvedBlocking,
  parseFindingText,
  writeReview,
};
