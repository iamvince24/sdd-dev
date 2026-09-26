'use strict';

const { BlockedError } = require('./errors');

const ESCALATORS = [
  'external_interface',
  'data_migration',
  'security_boundary',
  'hard_to_revert',
  'verification_insufficient',
  'material_uncertainty',
];

const DIRECT = ['clear', 'local', 'recoverable', 'verification_available'];

function suggestRoute(features) {
  const present = new Set(Array.isArray(features) ? features : []);
  const hit = ESCALATORS.find((name) => present.has(name));
  if (hit) return { route: 'full_pipeline', reason: hit };
  if (DIRECT.every((name) => present.has(name))) {
    return { route: 'direct', reason: 'local recoverable change with a verification method' };
  }
  return { route: 'full_pipeline', reason: 'not a clearly local recoverable change' };
}

function evaluate(doc) {
  if (!doc || typeof doc !== 'object') throw new BlockedError('case is missing');
  if (doc.question === 'route') return { route: suggestRoute(doc.features).route };
  if (doc.question === 'preexisting') return { status: 'blocked', pass: false };
  if (doc.question === 'permission') {
    return { status: 'blocked', method: doc.method, lowered: false };
  }
  throw new BlockedError(`unknown case question: ${doc.question || ''}`);
}

module.exports = { suggestRoute, evaluate };
