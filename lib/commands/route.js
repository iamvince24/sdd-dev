'use strict';

const { parseArgs } = require('../args');
const { UsageError } = require('../errors');
const { now } = require('../fsutil');
const { suggestRoute } = require('../cases');
const { changeRoute, recomputeAuthority } = require('../route');
const { modifiersFrom, openInstalled, runDirectory, resolveRunId, readManifest, writeManifest } = require('../runstore');

function suggest(argv) {
  const args = parseArgs(argv, { values: ['run', 'repo'], lists: ['risk'] });
  if (args._.length) throw new UsageError(`unexpected argument: ${args._[0]}`);
  const risks = args.lists.risk || [];
  if (!risks.length) throw new UsageError('--risk is required');
  for (const risk of risks) {
    if (!String(risk).trim()) throw new UsageError('--risk requires a value');
  }
  const suggestion = suggestRoute(risks);
  const { paths } = openInstalled(args.values.repo);
  const id = resolveRunId(paths, args.values.run);
  const dir = runDirectory(paths, id);
  const manifest = readManifest(paths, id);
  const previous = manifest.route;
  if (previous === suggestion.route) {
    const history = Array.isArray(manifest.route_history) ? manifest.route_history.slice() : [];
    history.push({
      at: now(),
      route: suggestion.route,
      modifiers: modifiersFrom(manifest.modifiers),
      reason: suggestion.reason,
      by: 'auto',
      risk_features: risks.map((item) => String(item)),
    });
    manifest.route_history = history;
    writeManifest(paths, id, manifest);
  } else {
    changeRoute(manifest, {
      route: suggestion.route,
      reason: suggestion.reason,
      by: 'auto',
      riskFeatures: risks,
    });
    manifest.implementation_authorized = false;
    recomputeAuthority(dir, manifest);
    writeManifest(paths, id, manifest);
  }
  console.log(`suggest ${previous} ${suggestion.route}`);
  console.log(`reason ${suggestion.reason}`);
  return 0;
}

module.exports = { suggest };
