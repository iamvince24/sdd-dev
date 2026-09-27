'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { writeSpec, approveSpec } = require('../spec');
const { save } = require('../manifest');
const { recomputeAuthority } = require('../route');
const { openInstalled, runDirectory, resolveRunId, readManifest } = require('../runstore');
const { appendEvent } = require('../events');

const CHANGED = new Set(['requirement', 'design', 'risk']);

function readStdin() {
  if (process.stdin.isTTY) throw new UsageError('stdin is a terminal; pass --file or a pipe');
  return fs.readFileSync(0, 'utf8');
}

function write(argv) {
  const args = parseArgs(argv, { values: ['file', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  let text;
  if (args.values.file) {
    const abs = path.resolve(args.values.file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new BlockedError(`file not found: ${args.values.file}`);
    text = fs.readFileSync(abs, 'utf8');
  } else {
    text = readStdin();
  }
  const dir = runDirectory(paths, id);
  const written = writeSpec(dir, text);
  const manifest = readManifest(paths, id);
  recomputeAuthority(dir, manifest);
  save(dir, manifest);
  console.log(`spec r${written.revision} ${id}`);
  return 0;
}

function parseChanged(raw) {
  if (raw === undefined) return null;
  const parts = String(raw).split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new UsageError('--changed requires a value');
  for (const part of parts) {
    if (!CHANGED.has(part)) throw new UsageError('--changed must be requirement, design, or risk');
  }
  return parts;
}

function approve(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo', 'carry-from', 'changed'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  let carryFrom = null;
  if (args.values['carry-from'] !== undefined) {
    carryFrom = Number(args.values['carry-from']);
    if (!Number.isInteger(carryFrom) || carryFrom < 1) throw new UsageError('--carry-from must be a revision number');
  }
  const changed = parseChanged(args.values.changed);
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  appendEvent(dir, 'approval_request', { reason: 'spec' });
  const result = approveSpec(dir, { carryFrom, changed });
  const reason = changed && changed.length ? `spec changed ${changed.join(',')}` : 'spec';
  appendEvent(dir, 'approval', { reason });
  console.log(`spec approval r${result.revision} ${id}`);
  return 0;
}

module.exports = { write, approve };
