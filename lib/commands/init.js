'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('../registry');
const tracking = require('../tracking');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { resolveRepo, repoPaths } = require('../repo');
const { TOOL_ROOT, CONFIG_SCHEMA, toolFiles, copyTool } = require('../tool');
const { readInstall, writeInstall, toolRecord, localRecord } = require('../install');
const { isInside, now, writeJson } = require('../fsutil');
const { defaultPolicy } = require('../policy');
const { assertNoRetiredCursorInstall } = require('../retired-platform');

const MODES = ['repo-local', 'shared-sibling'];
const TRACKING_HELP = `--tracking <track|ignore> is required in a git repository:
  track   .sdd-dev/ (config and runs) can be committed with this repo; *.local.json stays ignored
  ignore  .sdd-dev/ stays out of git through .sdd-dev/.gitignore`;

module.exports = function init(argv) {
  const args = parseArgs(argv, { values: ['mode', 'tracking', 'repo'], flags: ['yes'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const mode = args.values.mode;
  if (!MODES.includes(mode)) throw new UsageError('--mode must be repo-local or shared-sibling');

  const repo = resolveRepo(args.values.repo);
  const paths = repoPaths(repo.root);
  assertNoRetiredCursorInstall(repo.root);
  let trackingMode = null;
  if (repo.vcs === 'git') {
    trackingMode = args.values.tracking;
    if (!tracking.TRACKING.includes(trackingMode)) throw new UsageError(TRACKING_HELP);
  } else if (args.values.tracking) {
    console.log(`! --tracking ignored: ${repo.root} is not a git repository`);
  }

  const existing = readInstall(paths);
  if (existing && !existing.install.uninstalled_at) {
    throw new BlockedError(`already installed (${existing.install.mode}); use \`sdd mode switch\` or \`sdd update\``);
  }

  if (mode === 'repo-local') {
    if (TOOL_ROOT === paths.tool) throw new BlockedError('run init from an sdd-dev checkout, not from a vendored copy');
  } else {
    if (isInside(TOOL_ROOT, repo.root)) throw new BlockedError('shared-sibling needs the tool checkout outside the target repo');
    if (fs.existsSync(paths.tool)) throw new BlockedError('.sdd-dev/tool/ exists; use `sdd mode switch shared-sibling`');
    registry.assertWritable(TOOL_ROOT);
    if (path.dirname(TOOL_ROOT) !== path.dirname(repo.root)) console.log(`! the tool is not a sibling of the repo: ${TOOL_ROOT}`);
  }

  if (trackingMode === 'track' && !args.flags.yes) {
    const planned = ['.sdd-dev/.gitignore', '.sdd-dev/config/install.json', '.sdd-dev/config/policy.json'];
    const toolCount = mode === 'repo-local' ? toolFiles(TOOL_ROOT).length : 0;
    tracking.printTrackPreview(tracking.trackPreview(paths, planned, toolCount));
    return 1;
  }

  fs.mkdirSync(paths.config, { recursive: true });
  fs.mkdirSync(paths.runs, { recursive: true });
  const policyFile = path.join(paths.config, 'policy.json');
  if (!fs.existsSync(policyFile)) writeJson(policyFile, defaultPolicy());
  const toolRoot = mode === 'repo-local' ? paths.tool : TOOL_ROOT;
  if (mode === 'repo-local') copyTool(TOOL_ROOT, paths.tool);
  else registry.add(TOOL_ROOT, repo.root);

  const install = {
    config_schema: CONFIG_SCHEMA,
    mode,
    vcs: repo.vcs,
    tracking: trackingMode,
    tool: toolRecord(repo.root, toolRoot, TOOL_ROOT),
    created_at: now(),
    updated_at: now(),
  };
  writeInstall(paths, install, localRecord(repo.root, toolRoot));
  if (repo.vcs === 'git') tracking.writeRules(paths, trackingMode);

  console.log(`Installed sdd-dev (${mode}) in ${repo.root}`);
  console.log(`  tool: ${install.tool.path}`);
  console.log('  config: .sdd-dev/config/');
  console.log('  runs: .sdd-dev/runs/');
  if (repo.vcs !== 'git') {
    console.log('Not a git repository: data lives in .sdd-dev/; no git isolation is claimed.');
    return 0;
  }
  const problems = tracking.check(paths, trackingMode);
  for (const problem of problems) console.log(`✗ ${problem}`);
  if (problems.length) return 1;
  console.log(trackingMode === 'track'
    ? 'Tracking: track. Run `git add .sdd-dev` when you want to commit it.'
    : '✓ Tracking: ignore. git does not see .sdd-dev/.');
  return 0;
};
