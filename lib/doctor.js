'use strict';

const fs = require('fs');
const path = require('path');
const git = require('./git');
const registry = require('./registry');
const tracking = require('./tracking');
const { repoPaths } = require('./repo');
const { readInstall, resolveToolRoot } = require('./install');
const { CONFIG_SCHEMA, toolHash } = require('./tool');
const { walk, realpathOrNull, isInside } = require('./fsutil');

const SECRET_NAME = /^(\.env(\..+)?|.+\.local\.json|.+\.pem|.+\.key|id_(rsa|dsa|ecdsa|ed25519))$/;

// A vendored copy must never contain these; a shared checkout may keep them only if git ignores them.
function secretFiles(toolRoot, shared) {
  const files = walk(toolRoot, { skip: ['.git', 'node_modules', '.sdd-dev'] })
    .filter((file) => SECRET_NAME.test(path.posix.basename(file)));
  if (!shared) return files;
  if (!git.toplevel(toolRoot)) return files.filter((file) => file !== 'sdd-dev.local.json');
  const tracked = new Set(git.lsFiles(toolRoot, '.'));
  return files.filter((file) => tracked.has(file) || !git.isIgnored(toolRoot, file));
}

function diagnose(repo) {
  const paths = repoPaths(repo.root);
  const problems = [];
  const warnings = [];
  const found = readInstall(paths);
  if (!found) {
    problems.push('not installed: .sdd-dev/config/install.json is missing');
    return { problems, warnings, install: null };
  }
  const { install, local } = found;
  if (install.uninstalled_at) {
    problems.push(`uninstalled at ${install.uninstalled_at}; .sdd-dev/config/ and .sdd-dev/runs/ were retained`);
    return { problems, warnings, install };
  }
  const relink = `relink with \`sdd mode switch ${install.mode}\``;

  if (install.config_schema !== CONFIG_SCHEMA) {
    warnings.push(`config schema is ${install.config_schema}, this tool expects ${CONFIG_SCHEMA}; run \`sdd update\``);
  }
  if (install.vcs !== repo.vcs) problems.push(`install.json records vcs "${install.vcs}" but the repo is "${repo.vcs}"`);

  const resolved = resolveToolRoot(repo.root, install);
  if (!resolved) problems.push(`tool path "${install.tool && install.tool.path}" does not resolve from ${repo.root}; ${relink}`);
  if (!local) {
    problems.push(`.sdd-dev/config/install.local.json is missing; ${relink}`);
  } else {
    if (local.repo_root !== repo.root) problems.push(`repo moved: install.local.json records ${local.repo_root}; ${relink}`);
    if (resolved && local.tool_root !== resolved) {
      problems.push(`install.local.json records tool ${local.tool_root} but install.json resolves to ${resolved}; ${relink}`);
    }
  }

  if (install.mode === 'repo-local') {
    const vendored = realpathOrNull(paths.tool);
    if (!vendored) {
      problems.push('repo-local mode but .sdd-dev/tool/ is missing');
    } else {
      if (resolved && resolved !== vendored) problems.push('repo-local install.json does not point at .sdd-dev/tool/');
      if (toolHash(vendored) !== install.tool.hash) {
        problems.push('.sdd-dev/tool/ differs from the recorded hash (edited or partially updated)');
      }
    }
  } else if (install.mode === 'shared-sibling') {
    if (fs.existsSync(paths.tool)) problems.push('shared-sibling mode but .sdd-dev/tool/ exists');
    if (resolved) {
      if (isInside(resolved, repo.root)) problems.push('the shared tool lives inside this repo');
      const installs = registry.list(resolved);
      if (!installs.includes(repo.root)) problems.push(`the shared tool does not list this repo; ${relink}`);
      for (const other of installs) {
        if (!fs.existsSync(path.join(other, '.sdd-dev', 'config', 'install.json'))) {
          warnings.push(`the shared tool lists a repo without an install: ${other}`);
        }
      }
      if (toolHash(resolved) !== install.tool.hash) warnings.push('the shared tool changed since it was recorded; run `sdd update`');
    }
  } else {
    problems.push(`unknown mode "${install.mode}"`);
  }

  if (repo.vcs === 'git') {
    if (!tracking.TRACKING.includes(install.tracking)) {
      problems.push('tracking is not chosen; run `sdd config tracking <track|ignore>`');
    } else {
      problems.push(...tracking.check(paths, install.tracking));
    }
  }

  const scanRoot = install.mode === 'repo-local' ? realpathOrNull(paths.tool) : resolved;
  if (scanRoot) {
    for (const file of secretFiles(scanRoot, install.mode === 'shared-sibling')) {
      problems.push(`secret-looking file in the tool: ${file}`);
    }
  }
  return { problems, warnings, install };
}

function printDiagnosis(result) {
  const { install, problems, warnings } = result;
  if (install && !install.uninstalled_at) {
    console.log(`mode: ${install.mode}, vcs: ${install.vcs}, tracking: ${install.tracking || 'n/a'}`);
  }
  for (const problem of problems) console.log(`✗ ${problem}`);
  for (const warning of warnings) console.log(`! ${warning}`);
  if (problems.length === 0) console.log('✓ install is consistent');
}

module.exports = { diagnose, printDiagnosis, secretFiles };
