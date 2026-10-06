'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('../registry');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { resolveRepo, repoPaths } = require('../repo');
const { readInstall, writeInstall, resolveToolRoot } = require('../install');
const { restoreAll } = require('../instructions');
const { walk, realpathOrNull, now } = require('../fsutil');
const { assertNoRetiredCursorInstall } = require('../retired-platform');

module.exports = function uninstall(argv) {
  const args = parseArgs(argv, { values: ['repo'], flags: ['purge', 'yes'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  if (args.flags.yes && !args.flags.purge) throw new UsageError('--yes only applies together with --purge');
  const repo = resolveRepo(args.values.repo);
  const paths = repoPaths(repo.root);
  assertNoRetiredCursorInstall(repo.root);
  const found = readInstall(paths);
  if (!found) throw new BlockedError('sdd-dev is not installed here');
  const { install, local } = found;
  const shared = install.mode === 'shared-sibling'
    ? resolveToolRoot(repo.root, install) || (local && realpathOrNull(local.tool_root))
    : null;
  const repoRoots = [repo.root, local && local.repo_root].filter(Boolean);

  if (args.flags.purge && !args.flags.yes) {
    const files = walk(paths.base).map((file) => `.sdd-dev/${file}`);
    console.log(`--purge would delete everything under .sdd-dev/ (${files.length} files):`);
    for (const file of files) console.log(`  ${file}`);
    console.log('Nothing was deleted. Re-run with --purge --yes to delete.');
    return 1;
  }

  const restored = restoreAll(repo.root);
  for (const line of restored) console.log(line);

  if (args.flags.purge) {
    if (shared) registry.remove(shared, ...repoRoots);
    const files = walk(paths.base).map((file) => `.sdd-dev/${file}`);
    fs.rmSync(paths.base, { recursive: true, force: true });
    console.log(`Deleted .sdd-dev/ (${files.length} files).`);
    return 0;
  }

  if (!install.uninstalled_at) {
    if (install.mode === 'repo-local' && fs.existsSync(paths.tool)) {
      fs.rmSync(paths.tool, { recursive: true, force: true });
      console.log('Removed .sdd-dev/tool/.');
    }
    if (shared) {
      registry.remove(shared, ...repoRoots);
      console.log(`Unregistered from the shared tool at ${shared}.`);
    }
    if (!restored.length) console.log('No platform hooks are installed by this version.');
    install.uninstalled_at = now();
    writeInstall(paths, install);
  } else {
    console.log(`Already uninstalled at ${install.uninstalled_at}.`);
  }

  console.log('Retained (delete with `sdd uninstall --purge`):');
  for (const entry of fs.readdirSync(paths.base).sort()) {
    const isDir = fs.statSync(path.join(paths.base, entry)).isDirectory();
    console.log(`  .sdd-dev/${entry}${isDir ? '/' : ''}`);
  }
  return 0;
};
