'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { walk } = require('./fsutil');
const { BlockedError } = require('./errors');
const { contentHash } = require('./hash');

// Files above this are recorded as unknown and are not read. The placeholder
// (path + size) still goes into the hash so they are not dropped silently.
const SIZE_LIMIT = 1024 * 1024;

function gitText(cwd, args) {
  const result = git.run(cwd, args);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function under(relPath, file) {
  if (!relPath || relPath === '.') return true;
  const prefix = relPath.replace(/\/$/, '');
  return file === prefix || file.startsWith(`${prefix}/`);
}

function listUntracked(root, relPath) {
  const result = git.run(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean).filter((file) => {
    if (file === '.sdd-dev' || file.startsWith('.sdd-dev/')) return false;
    return under(relPath, file);
  }).sort();
}

function readBounded(root, rel) {
  const abs = path.join(root, rel);
  const size = fs.statSync(abs).size;
  if (size > SIZE_LIMIT) return { unknown: true, bytes: size };
  return { unknown: false, bytes: fs.readFileSync(abs) };
}

function feed(hash, unknown, root, rel) {
  const read = readBounded(root, rel);
  if (read.unknown) {
    unknown.push({ path: rel, bytes: read.bytes });
    hash.update(`unknown\0${rel}\0${read.bytes}\0`);
    return;
  }
  hash.update(`file\0${rel}\0`);
  hash.update(read.bytes);
  hash.update(Buffer.from('\0'));
}

function dirtyToken(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return 'deleted';
  const read = readBounded(root, rel);
  if (read.unknown) return 'unknown';
  return contentHash(read.bytes);
}

function dirtyHashes(root, files) {
  const hashes = {};
  for (const file of files) hashes[file] = dirtyToken(root, file);
  return hashes;
}

function gitCodebase(root, relPath) {
  const head = gitText(root, ['rev-parse', 'HEAD']);
  const branchName = gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const pathspec = !relPath || relPath === '.' ? ['.', ':(exclude).sdd-dev'] : [relPath];
  let diff = Buffer.alloc(0);
  if (head) {
    const result = git.runRaw(root, ['diff', 'HEAD', '--binary', '--', ...pathspec]);
    if (result.error) throw new BlockedError(`git diff failed: ${result.error.message}`);
    if (result.status !== 0) {
      const stderr = result.stderr ? result.stderr.toString('utf8').trim() : 'git diff failed';
      throw new BlockedError(stderr);
    }
    diff = result.stdout || Buffer.alloc(0);
  }

  const unknown = [];
  const hash = crypto.createHash('sha256');
  let used = false;
  if (diff.length) {
    hash.update(diff);
    hash.update(Buffer.from('\0'));
    used = true;
  }
  const dirty = [];
  if (head) {
    const names = git.run(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--', ...pathspec]);
    if (names.status === 0) {
      for (const file of names.stdout.split('\0').filter(Boolean)) {
        if (file === '.sdd-dev' || file.startsWith('.sdd-dev/')) continue;
        dirty.push(file);
      }
    }
  }
  for (const file of listUntracked(root, relPath)) {
    dirty.push(file);
    if (!used) {
      hash.update(Buffer.from('\0'));
      used = true;
    }
    feed(hash, unknown, root, file);
  }

  const dirtyFiles = [...new Set(dirty)].sort();
  return {
    vcs: 'git',
    branch: branchName && branchName !== 'HEAD' ? branchName : null,
    codebase_ref: {
      head: head || null,
      worktree_hash: used ? `sha256:${hash.digest('hex')}` : '',
      unknown,
    },
    dirty: dirtyFiles,
    dirty_hashes: dirtyHashes(root, dirtyFiles),
  };
}

function snapshotCodebase(root, relPath) {
  const base = !relPath || relPath === '.' ? root : path.resolve(root, relPath);
  const files = walk(base, { skip: ['.git', '.sdd-dev'] });
  const unknown = [];
  const hash = crypto.createHash('sha256');
  const dirty = [];
  for (const file of files) {
    const rel = !relPath || relPath === '.' ? file : `${relPath.replace(/\/$/, '')}/${file}`;
    dirty.push(rel);
    feed(hash, unknown, root, rel);
  }
  return {
    vcs: 'snapshot',
    branch: null,
    codebase_ref: {
      head: null,
      worktree_hash: files.length ? `sha256:${hash.digest('hex')}` : '',
      unknown,
    },
    dirty,
    dirty_hashes: dirtyHashes(root, dirty),
  };
}

function computeCodebase(root, relPath = '.') {
  return git.toplevel(root) ? gitCodebase(root, relPath) : snapshotCodebase(root, relPath);
}

function sameRef(a, b) {
  if (!a || !b) return false;
  return a.head === b.head
    && a.worktree_hash === b.worktree_hash
    && JSON.stringify(a.unknown || []) === JSON.stringify(b.unknown || []);
}

module.exports = { SIZE_LIMIT, computeCodebase, sameRef };
