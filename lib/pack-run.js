'use strict';

const fs = require('fs');
const path = require('path');
const { walk } = require('./fsutil');
const { redactBytes } = require('./redact');
const { recordRedaction } = require('./problems');
const { pack } = require('./tar');

function packRun(runDir) {
  const entries = walk(runDir).map((rel) => {
    const redacted = redactBytes(fs.readFileSync(path.join(runDir, rel)));
    return { name: rel, bytes: redacted.bytes, changed: redacted.changed };
  });
  if (entries.some((entry) => entry.changed)) {
    recordRedaction(runDir, 'export');
    const rel = 'problems.md';
    const bytes = redactBytes(fs.readFileSync(path.join(runDir, rel))).bytes;
    const existing = entries.find((entry) => entry.name === rel);
    if (existing) existing.bytes = bytes;
    else entries.push({ name: rel, bytes });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pack(entries.map(({ name, bytes }) => ({ name, bytes })));
}

module.exports = { packRun };
