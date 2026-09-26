'use strict';

const registry = require('../registry');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { resolveRepo, repoPaths } = require('../repo');
const { requireInstall, readInstall, writeInstall, toolRecord, resolveToolRoot } = require('../install');
const { TOOL_ROOT, CONFIG_SCHEMA, toolHash, toolVersion, copyTool, shortHash, describeVersion } = require('../tool');
const { MIGRATIONS, planMigrations } = require('../migrations');
const { walk, realpathOrNull, now } = require('../fsutil');

function planRepo(install, targetHash, targetSchema = CONFIG_SCHEMA, migrations = MIGRATIONS) {
  return {
    toolChanged: install.tool.hash !== targetHash,
    migrations: planMigrations(install.config_schema, targetSchema, migrations),
  };
}

function affectedRepos(repo, paths, install) {
  if (install.mode === 'repo-local') {
    if (realpathOrNull(paths.tool) === TOOL_ROOT) {
      console.log('! running the vendored copy; to update, run a newer checkout: node <checkout>/bin/sdd.js update --repo <repo>');
    }
    return [repo.root];
  }
  const shared = resolveToolRoot(repo.root, install);
  if (shared !== TOOL_ROOT) {
    throw new BlockedError(`shared-sibling tools are updated in place: update ${shared || install.tool.path} (for example git pull), then run its bin/sdd.js update`);
  }
  return [...new Set([repo.root, ...registry.list(TOOL_ROOT)])].filter((root) => {
    const found = readInstall(repoPaths(root));
    return found && !found.install.uninstalled_at && found.install.mode === 'shared-sibling'
      && resolveToolRoot(root, found.install) === TOOL_ROOT;
  });
}

function update(argv) {
  const args = parseArgs(argv, { values: ['repo'], flags: ['apply'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const repo = resolveRepo(args.values.repo);
  const paths = repoPaths(repo.root);
  const { install } = requireInstall(paths);
  const target = { hash: toolHash(TOOL_ROOT), version: toolVersion(TOOL_ROOT) };

  console.log(`sdd update — ${install.mode}`);
  console.log(`  current: ${describeVersion(install.tool.version)} (${shortHash(install.tool.hash)}), config schema ${install.config_schema}`);
  console.log(`  target:  ${describeVersion(target.version)} (${shortHash(target.hash)}), config schema ${CONFIG_SCHEMA}`);

  const plans = [];
  let blocked = false;
  for (const root of affectedRepos(repo, paths, install)) {
    const repoPathsFor = repoPaths(root);
    const repoInstall = readInstall(repoPathsFor).install;
    console.log(`Repo ${root}`);
    let plan;
    try {
      plan = planRepo(repoInstall, target.hash);
    } catch (error) {
      if (!(error instanceof BlockedError)) throw error;
      console.log(`  ✗ ${error.message}`);
      blocked = true;
      continue;
    }
    console.log(`  tool: ${plan.toolChanged ? `${shortHash(repoInstall.tool.hash)} -> ${shortHash(target.hash)}` : 'unchanged'}`);
    const configFiles = walk(repoPathsFor.config).filter((file) => !file.endsWith('.local.json'));
    console.log(`  config: ${configFiles.map((file) => `.sdd-dev/config/${file}`).join(', ') || 'none'}`);
    for (const step of plan.migrations) console.log(`  migration ${step.from} -> ${step.to}: ${step.describe}`);
    plans.push({ root, paths: repoPathsFor, install: repoInstall, plan });
  }
  if (blocked) return 1;
  if (plans.every(({ plan }) => !plan.toolChanged && plan.migrations.length === 0)) {
    console.log('Up to date.');
    return 0;
  }
  if (!args.flags.apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to update. .sdd-dev/runs/ is never touched.');
    return 0;
  }

  for (const { root, paths: repoPathsFor, install: repoInstall, plan } of plans) {
    for (const step of plan.migrations) step.apply(repoPathsFor.config);
    if (repoInstall.mode === 'repo-local') copyTool(TOOL_ROOT, repoPathsFor.tool);
    const toolRoot = repoInstall.mode === 'repo-local' ? repoPathsFor.tool : TOOL_ROOT;
    repoInstall.tool = toolRecord(root, toolRoot, TOOL_ROOT);
    repoInstall.config_schema = CONFIG_SCHEMA;
    repoInstall.updated_at = now();
    writeInstall(repoPathsFor, repoInstall);
    console.log(`✓ updated ${root}`);
  }
  console.log('.sdd-dev/runs/ was not touched.');
  return 0;
}

module.exports = update;
module.exports.planRepo = planRepo;
