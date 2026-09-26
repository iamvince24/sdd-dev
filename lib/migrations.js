'use strict';

const { BlockedError } = require('./errors');

// Each entry: { from, to, describe, apply(configDir) }. Schema 1 is the first release.
const MIGRATIONS = [];

function planMigrations(from, to, migrations = MIGRATIONS) {
  if (!Number.isInteger(from)) throw new BlockedError(`unknown config schema: ${from}`);
  if (from > to) throw new BlockedError(`config schema ${from} is newer than this tool (${to}); refusing to downgrade`);
  const steps = [];
  let current = from;
  while (current < to) {
    const step = migrations.find((migration) => migration.from === current);
    if (!step) throw new BlockedError(`no migration from config schema ${current} toward ${to}`);
    steps.push(step);
    current = step.to;
  }
  return steps;
}

module.exports = { MIGRATIONS, planMigrations };
