'use strict';

const fs = require('fs');
const path = require('path');

const LOCKS = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
]);

const USER_ACTION_COMMANDS = Object.freeze([
  'spec approve',
  'plan approve',
  'approval revoke',
  'review carry',
  'run route --by user',
  'grant add',
  'review write --reviewer-kind human',
]);
const USER_ACTION_COMMAND_SET = new Set(USER_ACTION_COMMANDS);

function tokensOf(command) {
  return (String(command).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function splitSegments(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|' || ch === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function injected(text) {
  const danger = text.includes('$(') || text.includes('`') || /(^|[^A-Za-z0-9_])eval([^A-Za-z0-9_]|$)/.test(text);
  if (!danger) return false;
  return /(^|[^A-Za-z0-9_])(git|rm|sdd)([^A-Za-z0-9_]|$)/.test(text);
}

function baseName(token) {
  return path.basename(String(token || '').replace(/\\/g, '/'));
}

function peel(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const name = baseName(tokens[i]);
    if (name === 'command' || name === 'sudo' || name === 'exec') {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function shellScript(tokens) {
  const name = baseName(tokens[0]);
  if (name !== 'bash' && name !== 'sh') return undefined;
  let flagAt = -1;
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i] === '--') break;
    if (tokens[i] === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/.test(tokens[i])) {
      flagAt = i;
      break;
    }
  }
  if (flagAt === -1) return undefined;
  return tokens[flagAt + 1] === undefined ? null : tokens[flagAt + 1];
}

function sddTail(tokens) {
  if (!tokens.length) return null;
  const first = String(tokens[0]).replace(/\\/g, '/');
  const name = baseName(first);
  if (name === 'sdd') return tokens.slice(1);
  if (name === 'npx' && tokens[1] === 'sdd') return tokens.slice(2);
  if (name === 'node' && typeof tokens[1] === 'string' && /(?:^|\/)bin\/sdd\.js$/.test(tokens[1].replace(/\\/g, '/'))) {
    return tokens.slice(2);
  }
  if (/(?:^|\/)\.sdd-dev\/tool\/bin\/sdd\.js$/.test(first) || /(?:^|\/)bin\/sdd\.js$/.test(first)) {
    return tokens.slice(1);
  }
  return null;
}

function isUserRoute(tail) {
  for (let i = 0; i < tail.length; i += 1) {
    if (tail[i] === '--by' && tail[i + 1] === 'user') return true;
    if (tail[i] === '--by=user') return true;
  }
  return false;
}

function userAction(tokens) {
  const tail = sddTail(tokens);
  if (!tail) return null;
  const pair = `${tail[0] || ''} ${tail[1] || ''}`;
  const humanReview = pair === 'review write' && tail.some((token, index) => (
    token === '--reviewer-kind=human' || (token === '--reviewer-kind' && tail[index + 1] === 'human')
  ));
  const command = pair === 'run route' && isUserRoute(tail) ? 'run route --by user'
    : humanReview ? 'review write --reviewer-kind human' : pair;
  if (USER_ACTION_COMMAND_SET.has(command)) return { op: 'user_action', scope: command };
  return null;
}

function flagParts(tokens) {
  const flags = [];
  const args = [];
  for (const token of tokens) {
    if (token === '--') continue;
    if (token.startsWith('-')) flags.push(token);
    else args.push(token);
  }
  return { flags, args };
}

function pushScope(args) {
  let spec = null;
  if (args.length >= 2) spec = args[1];
  else if (args.length === 1 && (args[0].includes(':') || args[0].includes('/') || args[0].startsWith('+'))) spec = args[0];
  if (!spec) return '';
  const forced = spec.startsWith('+') ? spec.slice(1) : spec;
  const branch = forced.includes(':') ? forced.split(':').pop() : forced;
  return branch.replace(/^\+/, '').replace(/^refs\/heads\//, '');
}

function refspecForced(arg) {
  if (arg.startsWith('+')) return true;
  const colon = arg.indexOf(':');
  return colon !== -1 && arg.slice(colon + 1).startsWith('+');
}

function classifyGit(tokens, ctx) {
  if (baseName(tokens[0]) !== 'git') return null;
  let i = 1;
  while (i < tokens.length) {
    if (tokens[i] === '-C' || tokens[i] === '-c' || tokens[i] === '--git-dir' || tokens[i] === '--work-tree') {
      i += 2;
      continue;
    }
    if (tokens[i].startsWith('-')) {
      i += 1;
      continue;
    }
    break;
  }
  const verb = tokens[i];
  const { flags, args } = flagParts(tokens.slice(i + 1));
  if (verb === 'reset' && flags.includes('--hard')) return { op: 'reset_hard', scope: args[0] || 'HEAD' };
  if (verb === 'rebase' || verb === 'filter-branch' || verb === 'filter-repo') {
    return { op: 'history_rewrite', scope: args[0] || '.' };
  }
  if (verb === 'commit' && flags.includes('--amend')) return { op: 'history_rewrite', scope: '.' };
  if (verb === 'commit') return { op: 'git_commit', scope: '.' };
  if (verb === 'clean' || verb === 'rm') {
    return classifyDeletes(verb === 'clean' && !args.length ? ['.'] : args, ctx);
  }
  if (verb !== 'push') return null;
  const forced = flags.some((flag) => (
    flag === '-f' || flag === '--force' || flag.startsWith('--force=')
    || flag === '--force-with-lease' || flag.startsWith('--force-with-lease=')
  )) || args.some(refspecForced);
  if (!forced) return null;
  return { op: 'force_push', scope: pushScope(args) };
}

function normRel(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

function covered(rel, roots) {
  const norm = normRel(rel);
  for (const root of roots || []) {
    const base = normRel(root);
    if (!base) continue;
    if (norm === base || norm.startsWith(`${base}/`)) return true;
  }
  return false;
}

function resolveReal(cwd, target) {
  const abs = path.resolve(cwd, target);
  const rest = [];
  let cursor = abs;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    rest.unshift(path.basename(cursor));
    cursor = parent;
  }
  let real = cursor;
  try {
    real = fs.realpathSync(cursor);
  } catch {
    real = cursor;
  }
  return path.join(real, ...rest);
}

function repoRelative(repoRoot, abs) {
  const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
  if (!rel) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

function globPrefix(target) {
  const index = target.search(/[*?[]/);
  if (index === -1) return null;
  return target.slice(0, index).replace(/\/+$/, '');
}

function classifyDeletes(targets, ctx) {
  const cwd = (ctx && ctx.cwd) || process.cwd();
  const repoRoot = (ctx && ctx.repoRoot) || cwd;
  const roots = (ctx && ctx.writeRoots) || [];
  const list = targets.length ? targets : ['.'];
  for (const target of list) {
    const prefix = globPrefix(target);
    if (prefix !== null) {
      const abs = resolveReal(cwd, prefix || '.');
      const rel = repoRelative(repoRoot, abs);
      if (rel === null || !covered(rel, roots)) {
        return { op: 'delete_outside_roots', scope: rel || abs };
      }
      continue;
    }
    const abs = resolveReal(cwd, target);
    const rel = repoRelative(repoRoot, abs);
    if (rel === null || !covered(rel, roots)) {
      return { op: 'delete_outside_roots', scope: rel || abs };
    }
  }
  return null;
}

function classifyRm(tokens, ctx) {
  if (baseName(tokens[0]) !== 'rm') return null;
  const { args } = flagParts(tokens.slice(1));
  return classifyDeletes(args, ctx);
}

function positionals(tokens) {
  return tokens.filter((token) => token !== '--' && !token.startsWith('-'));
}

function classifyDependency(tokens) {
  const name = baseName(tokens[0]);
  const args = positionals(tokens.slice(1));
  const sub = args[0];
  if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && (sub === 'install' || sub === 'add' || sub === 'ci')) {
    return { op: 'dependency_install', scope: sub };
  }
  if (name === 'pip' && sub === 'install') return { op: 'dependency_install', scope: 'install' };
  if (name === 'go' && sub === 'get') return { op: 'dependency_install', scope: 'get' };
  if (name === 'cargo' && sub === 'add') return { op: 'dependency_install', scope: 'add' };
  return null;
}

function classifyNetwork(tokens) {
  const name = baseName(tokens[0]);
  if (name !== 'curl' && name !== 'wget' && name !== 'ssh' && name !== 'scp') return null;
  const args = positionals(tokens.slice(1));
  return { op: 'network', scope: args[0] || '.' };
}

function classifyTokens(tokens, ctx) {
  const peeled = peel(tokens);
  if (!peeled.length) return null;
  return userAction(peeled)
    || classifyGit(peeled, ctx)
    || classifyRm(peeled, ctx)
    || classifyDependency(peeled)
    || classifyNetwork(peeled);
}

function collect(command, ctx, depth) {
  if (depth > 8) return [{ op: 'unparsed', scope: 'depth' }];
  if (injected(String(command))) return [{ op: 'unparsed', scope: 'substitution' }];
  const hits = [];
  for (const segment of splitSegments(String(command))) {
    if (injected(segment)) {
      hits.push({ op: 'unparsed', scope: 'substitution' });
      continue;
    }
    const tokens = tokensOf(segment);
    if (!tokens.length) continue;
    const inner = shellScript(peel(tokens));
    if (inner === null) {
      hits.push({ op: 'unparsed', scope: 'shell' });
      continue;
    }
    if (typeof inner === 'string') {
      hits.push(...collect(inner, ctx, depth + 1));
      continue;
    }
    const hit = classifyTokens(tokens, ctx);
    if (hit) hits.push(hit);
  }
  return hits;
}

function classify(command, ctx) {
  const hits = collect(command, ctx || {}, 0);
  return hits.length ? hits[0] : null;
}

function classifyPath(filePath, ctx) {
  const cwd = (ctx && ctx.cwd) || process.cwd();
  const repoRoot = (ctx && ctx.repoRoot) || cwd;
  const roots = (ctx && ctx.writeRoots) || [];
  const abs = resolveReal(cwd, filePath);
  const rel = repoRelative(repoRoot, abs);
  const scope = rel || abs;
  if (LOCKS.has(path.basename(String(filePath))) || LOCKS.has(path.basename(abs))) {
    return { op: 'lockfile_change', scope };
  }
  if (rel === null || !covered(rel, roots)) return { op: 'outside_write', scope };
  return null;
}

module.exports = { USER_ACTION_COMMANDS, classify, collect, classifyPath, tokensOf };
