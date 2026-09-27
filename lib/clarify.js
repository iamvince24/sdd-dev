'use strict';

const fs = require('fs');
const path = require('path');
const { load } = require('./manifest');
const { stripFrontmatter, sectionMap, parseItems } = require('./spec');
const { appendAuto } = require('./scope');

const SECTIONS = ['current_state', 'target_state', 'expected_delta', 'conflict', 'unknown', 'assumption'];
const PREFIX = {
  current_state: 'CS',
  target_state: 'TS',
  expected_delta: 'ED',
  conflict: 'CF',
  unknown: 'U',
  assumption: 'A',
};

function clarifyFile(runDir) {
  return path.join(runDir, 'clarify', 'state.md');
}

function readClarify(runDir) {
  const file = clarifyFile(runDir);
  if (!fs.existsSync(file)) return null;
  return stripFrontmatter(fs.readFileSync(file, 'utf8')).body;
}

function checkClarify(runDir, runId) {
  const problems = [];
  const manifest = load(runDir);
  const route = manifest && manifest.route;
  const body = readClarify(runDir);
  if (body == null) {
    if (route === 'full_pipeline') problems.push(`${runId} missing clarify/state.md`);
    return { problems };
  }
  const { map, duplicates } = sectionMap(body);
  for (const key of duplicates) problems.push(`${runId} clarify/state.md: duplicate section ${key}`);
  for (const key of SECTIONS) {
    if (!map.has(key)) problems.push(`${runId} clarify/state.md: missing section ${key}`);
  }
  for (const key of SECTIONS) {
    const prefix = PREFIX[key];
    for (const item of parseItems(map.get(key))) {
      const id = item.id || '';
      if (!new RegExp(`^${prefix}-[1-9][0-9]*$`).test(id)) {
        problems.push(`${runId} clarify/state.md: ${key} id is invalid`);
        continue;
      }
      if (!item.evidence) problems.push(`${runId} clarify/state.md: ${id} missing evidence`);
      if (item.blocking !== 'true' && item.blocking !== 'false') {
        problems.push(`${runId} clarify/state.md: ${id} blocking must be true or false`);
      }
    }
  }
  return { problems };
}

function blockingConflicts(runDir) {
  const body = readClarify(runDir);
  if (body == null) return [];
  const { answeredQuestions } = require('./spec');
  const answered = answeredQuestions(runDir);
  const items = parseItems(sectionMap(body).map.get('conflict'));
  const ids = [];
  for (const item of items) {
    if (item.blocking !== 'true') continue;
    if (!/^CF-[1-9][0-9]*$/.test(item.id || '')) continue;
    if (/^Q-[1-9][0-9]*$/.test(item.decision || '') && answered.has(item.decision)) continue;
    ids.push(item.id);
  }
  return ids;
}

function recordConflicts(runDir, runId) {
  const ids = blockingConflicts(runDir);
  if (!ids.length) return { line: '', problems: [] };
  const manifest = load(runDir);
  const reason = `route_reassess: conflict ${ids.join(', ')}`;
  if (manifest) appendAuto(runDir, manifest, reason);
  return {
    line: `route_reassess conflict ${ids.join(' ')}`,
    problems: ids.map((id) => `${runId} clarify/state.md: ${id} is a blocking conflict without a decision`),
  };
}

module.exports = { checkClarify, blockingConflicts, recordConflicts, SECTIONS };
