'use strict';

const fs = require('fs');
const path = require('path');
const { now } = require('./fsutil');
const { redactString } = require('./redact');

// Not part of role digests or revision freeze. Append-only, four fields.
function eventsFile(runDir) {
  return path.join(runDir, 'events.jsonl');
}

function nextId(text) {
  let max = 0;
  const matches = String(text).matchAll(/"id":"E-(\d+)"/g);
  for (const match of matches) max = Math.max(max, Number(match[1]));
  return `E-${max + 1}`;
}

function appendEvent(runDir, type, data, at) {
  const file = eventsFile(runDir);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const reason = redactString(String((data && data.reason) || '')).text;
  const row = {
    id: nextId(existing),
    type,
    at: at || now(),
    reason,
  };
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}${JSON.stringify(row)}\n`);
  return row;
}

function readEvents(runDir) {
  const file = eventsFile(runDir);
  if (!fs.existsSync(file)) return null;
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') events.push(row);
    } catch {
      // A broken line is not a measurement.
    }
  }
  return events;
}

module.exports = { appendEvent, readEvents, eventsFile };
