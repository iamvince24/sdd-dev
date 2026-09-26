'use strict';

const fs = require('fs');
const path = require('path');

function walk(root, { skip = [] } = {}) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  (function visit(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || skip.includes(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs, childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  })(root, '');
  return files;
}

function copyFiles(srcRoot, files, dstRoot) {
  for (const file of files) {
    const dst = path.join(dstRoot, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(srcRoot, file), dst);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function realpathOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function now() {
  return new Date().toISOString();
}

module.exports = { walk, copyFiles, readJson, writeJson, realpathOrNull, isInside, toPosix, now };
