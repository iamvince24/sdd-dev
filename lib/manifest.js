'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');
const { readJson, writeJson } = require('./fsutil');

function manifestFile(runDir) {
  return path.join(runDir, 'manifest.json');
}

function load(runDir) {
  const file = manifestFile(runDir);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse manifest.json: ${error.message}`);
  }
}

function save(runDir, manifest) {
  writeJson(manifestFile(runDir), manifest);
}

// `why` is the reason recorded with the status change. Persistence of that
// reason lands with the event log. Status is assigned first, then recomputed,
// so a transition out of awaiting_user is visible to the recompute.
function setStatus(runDir, manifest, next, why) {
  void why;
  manifest.status = next;
  const { recomputeStatus } = require('./status');
  recomputeStatus(runDir, manifest);
  save(runDir, manifest);
  return manifest.status;
}

module.exports = { load, save, setStatus };
