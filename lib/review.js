'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { stripFrontmatter, parseItems, checkCarry } = require('./spec');

function flagTrue(value) {
  return value === true || value === 'true';
}

function parseCarriedFrom(raw) {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return null;
  const end = raw.search(/\r?\n---\s*(?:\r?\n|$)/);
  if (end === -1) return null;
  const block = raw.slice(raw.indexOf('\n') + 1, end);
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^carried_from:\s*$/.test(lines[i])) continue;
    const revision = lines[i + 1] && lines[i + 1].match(/^  revision:\s*(.+)$/);
    const impact = lines[i + 2] && lines[i + 2].match(/^  impact:\s*(.+)$/);
    if (!revision || !impact) return { revision: NaN, impact: '' };
    return {
      revision: Number(String(revision[1]).trim().replace(/^["']|["']$/g, '')),
      impact: String(impact[1]).trim().replace(/^["']|["']$/g, ''),
    };
  }
  return null;
}

function carriedReviewCounts(runDir, revision, raw) {
  const carried = parseCarriedFrom(raw);
  if (!carried) return true;
  const problems = [];
  const { PLAN_CARRY } = require('./plan');
  checkCarry(runDir, 'run', { revision, carried_from: carried }, problems, PLAN_CARRY);
  return problems.length === 0;
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
  if (!carriedReviewCounts(runDir, revision, raw)) return empty;
  const verdict = fields.verdict || '';
  const findings = parseItems(body).filter((item) => (
    item.blocking !== undefined || /^F-[1-9][0-9]*$/.test(item.id || '')
  ));
  return { exists: true, rel, fields, verdict, findings, carried_from: parseCarriedFrom(raw) };
}

function unresolvedBlocking(findings) {
  return findings.filter((item) => flagTrue(item.blocking) && !flagTrue(item.resolved));
}

const REVIEW_KINDS = { plan: 'plan-review', result: 'result-review' };
const VERDICTS = new Set(['READY', 'REVISE', 'BLOCKED']);
const REVIEWER_KINDS = new Set(['human', 'agent']);
const FINDING_FIELDS = ['location', 'basis', 'severity', 'suggestion', 'resolution', 'blocking'];
const CATEGORIES = new Set(['security', 'data_loss', 'migration', 'interface_compat']);
const OPTIONAL_FIELDS = ['score', 'resolved', 'category', 'evidence'];

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
      const id = unquote(start[2]);
      if (/^D[1-7]$/.test(id)) {
        current = { skip: true };
        continue;
      }
      current = { id };
      findings.push(current);
      continue;
    }
    const cont = line.match(/^  ([a-z_]+):\s*(.*)$/);
    if (!cont || !current) throw new BlockedError(`finding line is not a field: ${line}`);
    if (current.skip) continue;
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
    if (finding.category !== undefined && !CATEGORIES.has(finding.category)) {
      throw new BlockedError(`${finding.id} category is invalid`);
    }
    if (finding.category && finding.blocking !== 'true') {
      throw new BlockedError(`${finding.id} category ${finding.category} must be blocking`);
    }
    if (finding.category && finding.resolved === 'true' && !finding.evidence) {
      throw new BlockedError(`${finding.id} resolved category requires evidence`);
    }
    const allowed = new Set(['id', ...FINDING_FIELDS, ...OPTIONAL_FIELDS]);
    for (const key of Object.keys(finding)) {
      if (!allowed.has(key)) throw new BlockedError(`${finding.id} has unknown field ${key}`);
    }
  }
  return findings;
}

function renderReview({ artifact, revision, verdict, reviewerKind, independent, contextId, findings, carriedFrom, dimensions }) {
  const lines = [
    '---',
    `artifact: ${artifact}`,
    `revision: ${revision}`,
    `verdict: ${verdict}`,
    `reviewer_kind: ${reviewerKind}`,
  ];
  if (independent === true) lines.push('independent: true');
  if (contextId) lines.push(`context_id: ${contextId}`);
  if (carriedFrom) {
    lines.push('carried_from:');
    lines.push(`  revision: ${carriedFrom.revision}`);
    lines.push(`  impact: ${carriedFrom.impact}`);
  }
  lines.push('---', '');
  for (const item of dimensions || []) {
    lines.push(`- id: ${item.id}`);
    lines.push(`  status: ${item.status}`);
    if (item.reason) lines.push(`  reason: ${item.reason}`);
    lines.push('');
  }
  for (const finding of findings) {
    lines.push(`- id: ${finding.id}`);
    for (const key of FINDING_FIELDS) lines.push(`  ${key}: ${finding[key]}`);
    if (finding.score !== undefined) lines.push(`  score: ${finding.score}`);
    if (finding.resolved !== undefined) lines.push(`  resolved: ${finding.resolved}`);
    if (finding.category !== undefined) lines.push(`  category: ${finding.category}`);
    if (finding.evidence !== undefined) lines.push(`  evidence: ${finding.evidence}`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

function dimensionItems(text) {
  return parseItems(text).filter((item) => /^D[1-7]$/.test(item.id || ''));
}

function dimensionProblems(text) {
  const items = dimensionItems(text);
  const problems = [];
  for (let n = 1; n <= 7; n += 1) {
    const id = `D${n}`;
    const item = items.find((entry) => entry.id === id);
    if (!item) {
      problems.push(`missing ${id}`);
      continue;
    }
    if (item.status !== 'checked' && item.status !== 'na') {
      problems.push(`${id} status must be checked or na`);
      continue;
    }
    if (item.status === 'na' && !String(item.reason || '').trim()) problems.push(`${id} na requires a reason`);
  }
  return problems;
}

function reviewDimensionProblems(runDir, revision) {
  const file = path.join(runDir, 'review', `plan-review-r${revision}.md`);
  if (!fs.existsSync(file)) return [];
  return dimensionProblems(stripFrontmatter(fs.readFileSync(file, 'utf8')).body);
}

function writeReview(runDir, { kind, revision, verdict, reviewerKind, independent, contextId, text, carriedFrom }) {
  const artifact = REVIEW_KINDS[kind];
  if (!artifact) throw new BlockedError('review kind must be plan or result');
  if (!VERDICTS.has(verdict)) throw new BlockedError('verdict must be READY, REVISE, or BLOCKED');
  if (!REVIEWER_KINDS.has(reviewerKind)) throw new BlockedError('reviewer_kind must be human or agent');
  if (!Number.isInteger(revision) || revision < 1) throw new BlockedError('review revision is missing');
  if (kind === 'plan') {
    const dims = dimensionProblems(text);
    if (dims.length) throw new BlockedError(dims[0]);
  }
  const findings = parseFindingText(text);
  const body = renderReview({
    artifact,
    revision,
    verdict,
    reviewerKind,
    independent: independent === true,
    contextId: contextId || '',
  findings,
  carriedFrom: carriedFrom || null,
  dimensions: dimensionItems(text),
});
  const rel = `review/${artifact}-r${revision}.md`;
  const file = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { rel, revision, artifact, findings: findings.length };
}

function carryReview(runDir, { kind, from }) {
  const artifact = REVIEW_KINDS[kind];
  if (!artifact) throw new BlockedError('review kind must be plan or result');
  const { currentPlanRevision, PLAN_CARRY } = require('./plan');
  const { load } = require('./manifest');
  const revision = currentPlanRevision(runDir);
  if (!revision) throw new BlockedError('plan revision is missing');
  if (!Number.isInteger(from) || from < 1 || from >= revision) {
    throw new BlockedError('carry source must be an earlier plan revision');
  }
  const sourceRel = `review/${artifact}-r${from}.md`;
  const source = loadReview(runDir, artifact, from);
  if (!source.exists) throw new BlockedError(`missing ${sourceRel}`);
  const manifest = load(runDir);
  const runId = (manifest && manifest.run_id) || 'run';
  const carried = { revision: from, impact: `plan/impact/r${revision}.md` };
  const problems = [];
  checkCarry(runDir, runId, { revision, carried_from: carried }, problems, PLAN_CARRY);
  if (problems.length) throw new BlockedError(problems[0]);
  const sourceRaw = fs.readFileSync(path.join(runDir, sourceRel), 'utf8');
  const written = writeReview(runDir, {
    kind,
    revision,
    verdict: source.verdict,
    reviewerKind: source.fields.reviewer_kind,
    independent: flagTrue(source.fields.independent),
    contextId: source.fields.context_id || '',
    text: stripFrontmatter(sourceRaw).body,
    carriedFrom: carried,
  });
  return written;
}

module.exports = {
  flagTrue,
  loadReview,
  carriedReviewCounts,
  unresolvedBlocking,
  parseFindingText,
  writeReview,
  carryReview,
  dimensionProblems,
  reviewDimensionProblems,
};
