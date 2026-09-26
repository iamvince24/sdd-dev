'use strict';

const { loadCapabilities } = require('./instructions');
const { readPolicy } = require('./policy');
const { now } = require('./fsutil');

const CELLS = [
  ['delegate', '獨立上下文的委派'],
  ['verify_on_stop', '工作結束時跑 verify'],
  ['block_destructive_git', '擋破壞性 git'],
];

function gapsFor(platform, matrix) {
  const row = matrix && matrix.cells && matrix.cells[platform];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
  const gaps = [];
  for (const [op, label] of CELLS) {
    if (row[op] !== false) continue;
    gaps.push({ op, layer: 'convention', gap: `${label} is not enforced by this platform` });
  }
  return gaps;
}

function delegationUnsupported(platform, matrix = loadCapabilities()) {
  const row = matrix && matrix.cells && platform && matrix.cells[platform];
  return !!(row && row.delegate === false);
}

function applyToManifest(manifest, configDir) {
  const platform = process.env.SDD_PLATFORM || manifest.platform || 'unknown';
  manifest.platform = platform;
  manifest.capability_limits = gapsFor(platform, loadCapabilities());
  const required = new Set((readPolicy(configDir).required_enforcement || []));
  if (!Array.isArray(manifest.blocks)) manifest.blocks = [];
  let blocked = false;
  for (const limit of manifest.capability_limits) {
    if (limit.layer !== 'convention' || !required.has(limit.op)) continue;
    blocked = true;
    const id = `capability:${limit.op}`;
    if (!manifest.blocks.some((item) => item && item.id === id)) {
      manifest.blocks.push({
        id,
        affected: ['*'],
        condition: `${limit.op} requires tool or platform enforcement`,
        at: now(),
      });
    }
  }
  if (blocked) manifest.status = 'blocked';
  return manifest;
}

module.exports = { CELLS, gapsFor, delegationUnsupported, applyToManifest };
