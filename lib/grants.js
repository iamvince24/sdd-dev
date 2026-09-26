'use strict';

const OPS = [
  'reset_hard',
  'force_push',
  'history_rewrite',
  'delete_outside_roots',
  'prod_write',
  'external_data_write',
  'dependency_install',
  'lockfile_change',
  'network',
];

function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i += 1;
      continue;
    }
    if (char === '*') {
      out += '[^/]*';
      continue;
    }
    out += /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${out}$`);
}

function covers(pattern, target) {
  if (typeof pattern !== 'string' || typeof target !== 'string' || !pattern || !target) return false;
  return globToRegExp(pattern).test(target);
}

function nextGrantId(grants) {
  let max = 0;
  for (const grant of grants || []) {
    const match = /^G-(\d+)$/.exec(grant.id || '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `G-${max + 1}`;
}

function matchGrant(grants, op, scope) {
  return (grants || []).find((grant) => grant.op === op && covers(grant.scope, scope)) || null;
}

module.exports = { OPS, covers, nextGrantId, matchGrant };
