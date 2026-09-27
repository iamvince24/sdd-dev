'use strict';

const { loadCapabilities } = require('./instructions');
const { readPolicy } = require('./policy');
const { now } = require('./fsutil');
const { setStatus } = require('./manifest');

const CELLS = [
  ['delegate', '獨立上下文的委派'],
  ['readonly_review', '唯讀審查'],
  ['browser', '瀏覽器'],
  ['block_destructive_git', '擋破壞性 git'],
  ['block_git_commit', '擋直接 git commit'],
  ['grant_enforcement', '依 grant 的 op 與 scope 放行'],
  ['block_install_network', '擋裝依賴與連網'],
  ['verify_on_stop', '工作結束時跑 verify'],
  ['user_action', '擋 agent 執行使用者專屬命令'],
];

function rowFor(platform, matrix) {
  const row = matrix && matrix.cells && matrix.cells[platform];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return row;
}

function gapsFor(platform, matrix) {
  const row = rowFor(platform, matrix);
  const gaps = [];
  for (const [op, label] of CELLS) {
    const gap = `${label} is not enforced by this platform`;
    const measured = row && Object.prototype.hasOwnProperty.call(row, op) ? row[op] : undefined;
    if (measured === true) continue;
    gaps.push({
      op,
      layer: 'convention',
      measured: measured === false,
      gap,
    });
  }
  return gaps;
}

function delegationUnsupported(platform, matrix = loadCapabilities()) {
  const row = matrix && matrix.cells && platform && matrix.cells[platform];
  return !!(row && row.delegate === false);
}

function applyToManifest(manifest, configDir, runDir, platform) {
  const chosen = platform || process.env.SDD_PLATFORM || manifest.platform || 'unknown';
  manifest.platform = chosen;
  manifest.capability_limits = gapsFor(chosen, loadCapabilities());
  const required = new Set((readPolicy(configDir).required_enforcement || []));
  if (!Array.isArray(manifest.blocks)) manifest.blocks = [];
  for (const limit of manifest.capability_limits) {
    if (limit.layer !== 'convention' || !required.has(limit.op)) continue;
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
  if (runDir) setStatus(runDir, manifest, manifest.status, 'capability');
  return manifest;
}

module.exports = { CELLS, gapsFor, delegationUnsupported, applyToManifest };
