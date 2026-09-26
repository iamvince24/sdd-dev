'use strict';

const fs = require('fs');
const path = require('path');
const git = require('./git');
const { UsageError } = require('./errors');

const SDD_DIR = '.sdd-dev';

function resolveRepo(input) {
  const dir = path.resolve(input || process.cwd());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new UsageError(`repo path is not a directory: ${dir}`);
  }
  const real = fs.realpathSync(dir);
  const top = git.toplevel(real);
  return top ? { root: top, vcs: 'git' } : { root: real, vcs: 'snapshot' };
}

function repoPaths(root) {
  const base = path.join(root, SDD_DIR);
  const config = path.join(base, 'config');
  return {
    root,
    base,
    tool: path.join(base, 'tool'),
    config,
    runs: path.join(base, 'runs'),
    installJson: path.join(config, 'install.json'),
    installLocal: path.join(config, 'install.local.json'),
    gitignore: path.join(base, '.gitignore'),
  };
}

module.exports = { SDD_DIR, resolveRepo, repoPaths };
