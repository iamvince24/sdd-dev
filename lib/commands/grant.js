'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { now } = require('../fsutil');
const { OPS, nextGrantId, matchGrant } = require('../grants');
const { openInstalled, resolveRunId, readManifest, writeManifest } = require('../runstore');

function requireOp(args) {
  if (!args.values.op || !args.values.scope) throw new UsageError('--op and --scope are required');
  if (!OPS.includes(args.values.op)) throw new UsageError(`--op must be one of ${OPS.join(', ')}`);
}

function load(args) {
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  return { paths, id, manifest: readManifest(paths, id) };
}

function add(argv) {
  const args = parseArgs(argv, { values: ['op', 'scope', 'source', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  requireOp(args);
  if (!/^Q-[1-9]\d*$/.test(args.values.source || '')) throw new UsageError('--source must be Q-<n>');
  const { paths, id, manifest } = load(args);
  if (!Array.isArray(manifest.grants)) manifest.grants = [];
  const grant = {
    id: nextGrantId(manifest.grants),
    op: args.values.op,
    scope: args.values.scope,
    source: args.values.source,
    granted_at: now(),
  };
  manifest.grants.push(grant);
  writeManifest(paths, id, manifest);
  console.log(`grant ${grant.id} ${grant.op} ${grant.scope}`);
  return 0;
}

function check(argv) {
  const args = parseArgs(argv, { values: ['op', 'scope', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  requireOp(args);
  const { manifest } = load(args);
  const hit = matchGrant(manifest.grants, args.values.op, args.values.scope);
  if (!hit) {
    console.error(`✗ no grant: ${args.values.op} ${args.values.scope}`);
    return 1;
  }
  console.log(`grant ${hit.id} ${hit.op} ${hit.scope}`);
  return 0;
}

module.exports = { add, check };
