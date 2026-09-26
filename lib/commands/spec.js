'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../args');
const { UsageError, BlockedError } = require('../errors');
const { writeSpec } = require('../spec');
const { openInstalled, runDirectory, resolveRunId } = require('../runstore');

function readStdin() {
  if (process.stdin.isTTY) throw new UsageError('stdin is a terminal; pass --file or a pipe');
  return fs.readFileSync(0, 'utf8');
}

module.exports = function specWrite(argv) {
  const args = parseArgs(argv, { values: ['file', 'run', 'repo'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  let text;
  if (args.values.file) {
    const abs = path.resolve(args.values.file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new BlockedError(`file not found: ${args.values.file}`);
    text = fs.readFileSync(abs, 'utf8');
  } else {
    text = readStdin();
  }
  const written = writeSpec(runDirectory(paths, id), text);
  console.log(`spec r${written.revision} ${id}`);
  return 0;
};
