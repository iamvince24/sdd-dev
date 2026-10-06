'use strict';

const fs = require('fs');
const path = require('path');
const { BlockedError } = require('./errors');

function assertSafeTarget(root, file, label = file) {
  const base = path.resolve(root);
  const abs = path.resolve(file);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    throw new BlockedError(`target escapes repo: ${label}`);
  }
  let current = base;
  const baseStat = fs.lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new BlockedError(`unsafe repo target: ${label}`);
  const parts = rel.split(path.sep);
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new BlockedError(`unsafe target type: ${label}`);
    }
  }
  return abs;
}

function readUtf8(file, label = file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new BlockedError(`non-UTF-8 target: ${label}`);
  return text;
}

module.exports = { assertSafeTarget, readUtf8 };
