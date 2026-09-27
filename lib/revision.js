'use strict';

const fs = require('fs');
const path = require('path');
const { contentHash } = require('./hash');

// Hash is the raw file bytes. Check compares this to approvals/*.json and
// does not rewrite either side. A content_hash line inside the file is just
// more bytes; it is not stripped.
function revisionHash(buf) {
  return contentHash(buf);
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { source_refs: [] };
  const end = text.search(/\r?\n---\s*(?:\r?\n|$)/);
  if (end === -1) return { source_refs: [] };
  const block = text.slice(text.indexOf('\n') + 1, end);
  const sourceRefs = [];
  let inRefs = false;
  let current = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^source_refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (/^\S/.test(line)) break;
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+path:\s*(.*?)\s*$/);
    if (item) {
      current = { path: unquote(item[1]) };
      sourceRefs.push(current);
      continue;
    }
    const id = line.match(/^\s+id:\s*(.*?)\s*$/);
    if (id && current) current.id = unquote(id[1]);
  }
  return { source_refs: sourceRefs };
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, '');
}

function approvalRevisionPath(doc) {
  if (!doc || !Number.isInteger(doc.revision) || doc.revision < 1) return null;
  if (doc.artifact === 'plan') return `plan/revisions/r${doc.revision}.md`;
  if (doc.artifact === 'execution-spec') return `spec/revisions/r${doc.revision}.md`;
  return null;
}

function listMarkdown(runDir, dir) {
  const abs = path.join(runDir, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `${dir}/${name}`);
}

function revisionFiles(runDir) {
  // events.jsonl is append-only measurement state, not a frozen revision.
  return [
    ...listMarkdown(runDir, 'spec/revisions'),
    ...listMarkdown(runDir, 'plan/revisions'),
    ...listMarkdown(runDir, 'review'),
  ];
}

module.exports = {
  revisionHash,
  parseFrontmatter,
  approvalRevisionPath,
  revisionFiles,
};
