'use strict';

const { UsageError } = require('./errors');

function parseArgs(argv, { values = [], flags = [], lists = [] } = {}) {
  const out = { _: [], values: {}, flags: {}, lists: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (flags.includes(key)) {
      if (eq !== -1) throw new UsageError(`--${key} does not take a value`);
      out.flags[key] = true;
    } else if (values.includes(key) || lists.includes(key)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        throw new UsageError(`--${key} requires a value`);
      }
      if (lists.includes(key)) {
        if (!out.lists[key]) out.lists[key] = [];
        out.lists[key].push(value);
      } else {
        out.values[key] = value;
      }
    } else {
      throw new UsageError(`unknown option --${key}`);
    }
  }
  return out;
}

module.exports = { parseArgs };
