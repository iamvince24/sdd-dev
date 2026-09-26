'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('../registry');
const tracking = require('../tracking');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { resolveRepo, repoPaths } = require('../repo');
const { requireInstall, writeInstall, toolRecord, localRecord, resolveToolRoot } = require('../install');
const { TOOL_ROOT, toolFiles, copyTool } = require('../tool');
const { diagnose, printDiagnosis } = require('../doctor');
const { realpathOrNull, isInside, toPosix, now } = require('../fsutil');

const MODES = ['repo-local', 'shared-sibling'];

// Switching to the same mode only relinks paths; it never replaces tool files (that is `sdd update`).
module.exports = function modeSwitch(argv) {
  const args = parseArgs(argv, { values: ['repo'], flags: ['yes'] });
  const target = args._[0];
  if (args._.length !== 1 || !MODES.includes(target)) {
    throw new UsageError('usage: sdd mode switch <repo-local|shared-sibling> [--repo <path>] [--yes]');
  }
  const repo = resolveRepo(args.values.repo);
  const paths = repoPaths(repo.root);
  const { install, local } = requireInstall(paths);
  const oldShared = install.mode === 'shared-sibling'
    ? resolveToolRoot(repo.root, install) || (local && realpathOrNull(local.tool_root))
    : null;
  const oldRepoRoots = [repo.root, local && local.repo_root].filter(Boolean);

  let toolRoot;
  let record;
  if (target === 'repo-local') {
    const vendored = realpathOrNull(paths.tool);
    const needsCopy = install.mode === 'shared-sibling' || !vendored;
    if (needsCopy && TOOL_ROOT === paths.tool) throw new BlockedError('run this from an sdd-dev checkout, not from a vendored copy');
    if (needsCopy && install.tracking === 'track' && !args.flags.yes) {
      tracking.printTrackPreview(tracking.trackPreview(paths, [], toolFiles(TOOL_ROOT).length));
      return 1;
    }
    if (oldShared) registry.remove(oldShared, ...oldRepoRoots);
    if (needsCopy) copyTool(TOOL_ROOT, paths.tool);
    toolRoot = paths.tool;
    record = needsCopy
      ? toolRecord(repo.root, toolRoot, TOOL_ROOT)
      : { ...install.tool, path: toPosix(path.relative(repo.root, toolRoot)) };
  } else {
    if (isInside(TOOL_ROOT, repo.root)) throw new BlockedError('run this from the shared sdd-dev checkout outside the repo');
    registry.assertWritable(TOOL_ROOT);
    if (fs.existsSync(paths.tool)) {
      fs.rmSync(paths.tool, { recursive: true, force: true });
      console.log('Removed .sdd-dev/tool/ (tool files only; config/ and runs/ kept).');
    }
    if (oldShared) registry.remove(oldShared, ...oldRepoRoots);
    registry.add(TOOL_ROOT, repo.root);
    if (path.dirname(TOOL_ROOT) !== path.dirname(repo.root)) console.log(`! the tool is not a sibling of the repo: ${TOOL_ROOT}`);
    toolRoot = TOOL_ROOT;
    record = install.mode === 'shared-sibling' && oldShared === TOOL_ROOT
      ? { ...install.tool, path: toPosix(path.relative(repo.root, toolRoot)) }
      : toolRecord(repo.root, toolRoot);
  }

  install.mode = target;
  install.tool = record;
  install.updated_at = now();
  writeInstall(paths, install, localRecord(repo.root, toolRoot));
  console.log(`Mode: ${target} (tool: ${record.path})`);
  const result = diagnose(repo);
  printDiagnosis(result);
  return result.problems.length ? 1 : 0;
};
