'use strict';

const fs = require('fs');
const path = require('path');
const { UsageError, BlockedError } = require('./errors');
const { contentHash } = require('./hash');
const { readJson, writeJson } = require('./fsutil');

const TOOL_ROOT = path.join(__dirname, '..');
const PLATFORMS = ['claude-code', 'cursor', 'codex'];
const ROUTES = ['direct'];
const RULE_OPEN = '<!-- sdd-rule ';
const RULE_CLOSE = '<!-- /sdd-rule -->';
const SECTION_OPEN = '<!-- sdd-instructions:direct:start';
const SECTION_CLOSE = '<!-- sdd-instructions:direct:end -->';

const DEST = {
  'claude-code': '.claude/commands/sdd-direct.md',
  cursor: '.cursor/rules/sdd-direct.mdc',
  codex: 'AGENTS.md',
};

function policyPath(root) {
  return path.join(root, 'templates', 'routes', 'policy.json');
}

function capabilitiesPath(root) {
  return path.join(root, 'integrations', 'capabilities.json');
}

function loadModelNames(root = TOOL_ROOT) {
  let doc;
  try {
    doc = readJson(policyPath(root));
  } catch (error) {
    throw new BlockedError(`cannot read instruction policy: ${error.message}`);
  }
  if (!doc || !Array.isArray(doc.model_names) || !doc.model_names.length) {
    throw new BlockedError('instruction policy model_names must be a non-empty list');
  }
  return doc.model_names.map((name) => {
    if (typeof name !== 'string' || !name.trim()) throw new BlockedError('instruction policy has an empty model name');
    return name.trim();
  });
}

function escapeRegExp(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

function modelNameHits(text, names) {
  const hits = [];
  for (const name of names) {
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(name)}(?:[^A-Za-z0-9]|$)`, 'i');
    if (pattern.test(text)) hits.push(name);
  }
  return hits;
}

function loadRule(route, root = TOOL_ROOT) {
  if (!ROUTES.includes(route)) throw new UsageError(`--route must be ${ROUTES.join(', ')}`);
  const file = path.join(root, 'templates', 'routes', `${route}.md`);
  if (!fs.existsSync(file)) throw new BlockedError(`route source is missing: templates/routes/${route}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/<!-- sdd-rule -->\n([\s\S]*?)\n<!-- \/sdd-rule -->/);
  if (!match) throw new BlockedError(`route source has no sdd-rule block: ${route}`);
  return match[1];
}

function loadCapabilities(root = TOOL_ROOT) {
  const file = capabilitiesPath(root);
  if (!fs.existsSync(file)) return { cells: {} };
  try {
    const doc = readJson(file);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('capabilities.json must be an object');
    if (doc.cells != null && (typeof doc.cells !== 'object' || Array.isArray(doc.cells))) {
      throw new Error('capabilities.json cells must be an object');
    }
    return { cells: doc.cells || {} };
  } catch (error) {
    throw new BlockedError(`cannot read capabilities.json: ${error.message}`);
  }
}

function isVerified(platform, route, matrix) {
  const cells = matrix && matrix.cells;
  const row = cells && cells[platform];
  return Boolean(row && row[route] === true);
}

function fence(rule, hash) {
  return `${RULE_OPEN}${hash} -->\n${rule}\n${RULE_CLOSE}`;
}

function render(platform, route, options = {}) {
  if (!PLATFORMS.includes(platform)) {
    throw new UsageError(`--platform must be ${PLATFORMS.join(', ')}`);
  }
  const root = options.root || TOOL_ROOT;
  const rule = loadRule(route, root);
  const hash = contentHash(Buffer.from(rule, 'utf8'));
  const matrix = options.matrix || loadCapabilities(root);
  const verified = isVerified(platform, route, matrix);
  const body = fence(rule, hash);
  let text;
  if (platform === 'claude-code') {
    text = `---\ndescription: Walk one direct run\nverified: ${verified}\n---\n\n${body}\n`;
  } else if (platform === 'cursor') {
    text = `---\ndescription: Walk one direct run\nalwaysApply: false\nverified: ${verified}\n---\n\n${body}\n`;
  } else {
    text = `${SECTION_OPEN} verified: ${verified} -->\n${body}\n${SECTION_CLOSE}\n`;
  }
  return {
    platform,
    route,
    dest: DEST[platform],
    rule,
    hash,
    verified,
    text,
  };
}

function extractRule(text) {
  const match = text.match(/<!-- sdd-rule (sha256:[0-9a-f]+) -->\n([\s\S]*?)\n<!-- \/sdd-rule -->/);
  if (!match) return null;
  return { hash: match[1], rule: match[2] };
}

function recordDir(repoRoot) {
  return path.join(repoRoot, '.sdd-dev', 'instructions');
}

function recordPath(repoRoot, platform) {
  return path.join(recordDir(repoRoot), `${platform}.json`);
}

function readRecord(repoRoot, platform) {
  const file = recordPath(repoRoot, platform);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (error) {
    throw new BlockedError(`cannot parse instructions record for ${platform}: ${error.message}`);
  }
}

function destination(repoRoot, rel) {
  const abs = path.resolve(repoRoot, rel);
  const relative = path.relative(repoRoot, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BlockedError(`instruction path escapes the repo: ${rel}`);
  }
  return abs;
}

function spliceSection(original, section) {
  const start = original.indexOf(SECTION_OPEN);
  const end = original.indexOf(SECTION_CLOSE);
  let base = original;
  if (start !== -1 && end !== -1 && end > start) {
    base = original.slice(0, start) + original.slice(end + SECTION_CLOSE.length);
  }
  if (base.length === 0) return section;
  const sep = base.endsWith('\n') ? '\n' : '\n\n';
  return `${base}${sep}${section}`;
}

function installedBytes(platform, original, section) {
  if (platform === 'codex') {
    if (original && !Buffer.from(original.toString('utf8'), 'utf8').equals(original)) {
      throw new BlockedError('AGENTS.md is not utf-8; refusing to splice');
    }
    return Buffer.from(spliceSection(original ? original.toString('utf8') : '', section), 'utf8');
  }
  return Buffer.from(section, 'utf8');
}

function installInto(repoRoot, platform, route, options = {}) {
  const rendered = render(platform, route, options);
  const abs = destination(repoRoot, rendered.dest);
  let record = readRecord(repoRoot, platform);
  if (record && record.route !== route) {
    throw new BlockedError(`instructions for ${platform} are already installed for ${record.route}`);
  }
  const existed = record ? record.existed : fs.existsSync(abs);
  const original = existed
    ? Buffer.from(record ? record.original_base64 : fs.readFileSync(abs).toString('base64'), 'base64')
    : null;
  const base = platform === 'codex' && fs.existsSync(abs) ? fs.readFileSync(abs) : original;
  const bytes = installedBytes(platform, base, rendered.text);
  if (!record) {
    record = {
      platform,
      route,
      path: rendered.dest,
      existed,
      original_base64: original ? original.toString('base64') : null,
    };
    fs.mkdirSync(recordDir(repoRoot), { recursive: true });
    writeJson(recordPath(repoRoot, platform), record);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return rendered;
}

function removeEmptyParents(file, repoRoot) {
  let dir = path.dirname(file);
  while (dir !== repoRoot && dir.startsWith(`${repoRoot}${path.sep}`)) {
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function restoreOne(repoRoot, platform, route) {
  const record = readRecord(repoRoot, platform);
  if (!record) return null;
  if (route && record.route !== route) {
    throw new BlockedError(`installed instructions for ${platform} are ${record.route}`);
  }
  if (record.path !== DEST[platform]) throw new BlockedError(`instruction record path is not owned: ${record.path}`);
  const abs = destination(repoRoot, record.path);
  if (record.existed) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(record.original_base64, 'base64'));
  } else if (fs.existsSync(abs)) {
    fs.unlinkSync(abs);
    removeEmptyParents(abs, repoRoot);
  }
  fs.unlinkSync(recordPath(repoRoot, platform));
  const dir = recordDir(repoRoot);
  if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  return record.existed ? `restored ${record.path}` : `removed ${record.path}`;
}

function restoreAll(repoRoot) {
  const dir = recordDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => restoreOne(repoRoot, name.slice(0, -'.json'.length)))
    .filter(Boolean);
}

module.exports = {
  TOOL_ROOT,
  PLATFORMS,
  ROUTES,
  DEST,
  loadModelNames,
  modelNameHits,
  loadRule,
  loadCapabilities,
  render,
  extractRule,
  installInto,
  restoreOne,
  restoreAll,
};
