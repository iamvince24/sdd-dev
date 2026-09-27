'use strict';

const fs = require('fs');
const path = require('path');
const { UsageError, BlockedError } = require('./errors');
const { run } = require('./git');

const PROBLEM_KEYS = [
  'impact',
  'handling',
  'reason',
  'result',
  'blocks_downstream',
  'affects',
  'evidence',
];

function problemsFile(runDir) {
  return path.join(runDir, 'problems.md');
}

function readText(runDir) {
  const file = problemsFile(runDir);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function nextProblemId(text) {
  const nums = [...String(text).matchAll(/^## P-(\d+)/gm)].map((match) => Number(match[1]));
  return `P-${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

function formatProblem(id, fields) {
  const lines = [`## ${id}`];
  for (const key of PROBLEM_KEYS) {
    const value = fields[key] == null ? '' : fields[key];
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

function appendProblem(runDir, fields) {
  const existing = readText(runDir);
  const id = nextProblemId(existing);
  const entry = formatProblem(id, fields);
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(problemsFile(runDir), `${prefix}${entry}`);
  return id;
}

function recordRedaction(runDir, where) {
  appendProblem(runDir, {
    impact: `${where} 含憑證形狀`,
    handling: '已改寫為 [redacted]',
    reason: '秘密不進 runs',
    result: 'redacted',
    blocks_downstream: 'false',
    affects: '',
    evidence: '',
  });
}

function parseProblems(text) {
  const problems = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const head = line.match(/^## (P-[1-9][0-9]*)\s*$/);
    if (head) {
      current = { id: head[1], fields: {} };
      problems.push(current);
      continue;
    }
    const field = line.match(/^- ([a-z_]+):\s*(.*)$/);
    if (field && current) current.fields[field[1]] = field[2];
  }
  return problems;
}

function updateProblem(text, id, updates) {
  const lines = String(text || '').split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === `## ${id}`) start = i;
    else if (start !== -1 && i > start && lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  if (start === -1) return null;
  const section = lines.slice(start, end);
  const seen = new Set();
  for (let i = 0; i < section.length; i += 1) {
    const match = section[i].match(/^- ([a-z_]+):/);
    if (!match) continue;
    seen.add(match[1]);
    if (Object.prototype.hasOwnProperty.call(updates, match[1])) {
      section[i] = `- ${match[1]}: ${updates[match[1]]}`;
    }
  }
  for (const key of Object.keys(updates)) {
    if (!seen.has(key)) section.push(`- ${key}: ${updates[key]}`);
  }
  const next = lines.slice(0, start).concat(section, lines.slice(end));
  const body = next.join('\n');
  return body.endsWith('\n') ? body : `${body}\n`;
}

function writeProblemUpdate(runDir, id, updates) {
  const text = readText(runDir);
  const next = updateProblem(text, id, updates);
  if (next == null) throw new BlockedError(`problems.md has no ${id}`);
  fs.writeFileSync(problemsFile(runDir), next);
}

function fileInRun(runDir, evidence) {
  const text = String(evidence).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!text || path.isAbsolute(text)) return null;
  const parts = text.split('/');
  if (parts.indexOf('..') !== -1 || parts.indexOf('.') !== -1) return null;
  const root = fs.realpathSync(runDir);
  const abs = path.resolve(root, text);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return text;
}

function acceptEvidence(repoRoot, runDir, evidence) {
  if (typeof evidence !== 'string' || !evidence.trim()) throw new UsageError('--evidence is required');
  const text = evidence.trim();
  const file = fileInRun(runDir, text);
  if (file) return file;
  if (/^[0-9a-f]{7,64}$/i.test(text) && run(repoRoot, ['cat-file', '-e', `${text}^{commit}`]).status === 0) {
    return text;
  }
  throw new BlockedError(`evidence is not a file in the run or a commit: ${text}`);
}

function problemEvidenceProblems(runDir, runId) {
  const problems = [];
  const text = readText(runDir);
  if (!text) return problems;
  for (const item of parseProblems(text)) {
    const fields = item.fields;
    const downstream = fields.blocks_downstream === 'true';
    const result = (fields.result || '').trim();
    const evidence = (fields.evidence || '').trim();
    if (downstream && result && !evidence) {
      problems.push(`${runId} problems.md: ${item.id} blocks downstream without evidence`);
    }
  }
  return problems;
}

module.exports = {
  appendProblem,
  recordRedaction,
  parseProblems,
  writeProblemUpdate,
  acceptEvidence,
  problemEvidenceProblems,
};
