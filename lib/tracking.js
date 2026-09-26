'use strict';

const fs = require('fs');
const git = require('./git');
const { walk } = require('./fsutil');

const TRACKING = ['track', 'ignore'];
const HEADER = '# Managed by sdd-dev. Change with `sdd config tracking <track|ignore>`.\n';
const RULES = {
  ignore: '*\n',
  track: 'config/*.local.json\n',
};

function rulesContent(mode) {
  return HEADER + RULES[mode];
}

function writeRules(paths, mode) {
  fs.mkdirSync(paths.base, { recursive: true });
  fs.writeFileSync(paths.gitignore, rulesContent(mode));
}

function check(paths, mode) {
  const problems = [];
  const content = fs.existsSync(paths.gitignore) ? fs.readFileSync(paths.gitignore, 'utf8') : null;
  if (content !== rulesContent(mode)) {
    problems.push(`.sdd-dev/.gitignore does not match tracking "${mode}"; run \`sdd config tracking ${mode}\``);
  }
  const tracked = git.lsFiles(paths.root, '.sdd-dev');
  if (mode === 'ignore') {
    for (const file of tracked) {
      problems.push(`${file}: tracked by git although tracking is "ignore" (left in place; untrack it yourself if intended)`);
    }
    if (!git.isIgnored(paths.root, '.sdd-dev/config/install.json')) {
      problems.push('.sdd-dev/config/install.json is not matched by any ignore rule');
    }
  } else {
    for (const file of tracked.filter((name) => name.endsWith('.local.json'))) {
      problems.push(`${file}: local file is tracked by git`);
    }
    if (!git.isIgnored(paths.root, '.sdd-dev/config/install.local.json')) {
      problems.push('.sdd-dev/config/install.local.json is not matched by any ignore rule');
    }
  }
  return problems;
}

function trackPreview(paths, planned = [], plannedToolFiles = 0) {
  const existing = walk(paths.base).map((file) => `.sdd-dev/${file}`);
  const all = [...new Set([...existing, ...planned])].filter((file) => !file.endsWith('.local.json')).sort();
  const toolCount = Math.max(all.filter((file) => file.startsWith('.sdd-dev/tool/')).length, plannedToolFiles);
  const lines = all.filter((file) => !file.startsWith('.sdd-dev/tool/'));
  if (toolCount) lines.push(`.sdd-dev/tool/ (${toolCount} tool files)`);
  return lines;
}

function printTrackPreview(lines) {
  console.log('With tracking "track", these paths become trackable (git add .sdd-dev):');
  for (const line of lines) console.log(`  ${line}`);
  console.log('  .sdd-dev/config/*.local.json stays ignored.');
  console.log('Nothing was written. Re-run with --yes to confirm.');
}

module.exports = { TRACKING, rulesContent, writeRules, check, trackPreview, printTrackPreview };
