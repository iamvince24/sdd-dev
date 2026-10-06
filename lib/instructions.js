'use strict';

const fs = require('fs');
const path = require('path');
const { UsageError, BlockedError } = require('./errors');
const { contentHash } = require('./hash');
const { readJson, writeJson } = require('./fsutil');
const { assertSafeTarget, readUtf8 } = require('./safe-target');

const TOOL_ROOT = path.join(__dirname, '..');
const PLATFORMS = ['claude-code', 'cursor', 'codex'];
const ROUTES = ['direct', 'full_pipeline', 'selected_advisors'];
const ROLE_ORDER = ['scout', 'planner', 'plan-reviewer', 'executor', 'security-reviewer', 'verifier'];
const RULE_OPEN = '<!-- sdd-rule ';
const RULE_CLOSE = '<!-- /sdd-rule -->';
const BOOTSTRAP = 'CLAUDE.md';
const BOOT_OPEN = '<!-- sdd-bootstrap:start -->';
const BOOT_CLOSE = '<!-- sdd-bootstrap:end -->';
const BOOT_TEXT = `${BOOT_OPEN}\nSDD 工作：先確認目前 run，再執行 sdd run next --run <id> --json，依 action 處理。continue 時接著做已授權且可執行的事；wait_user 或 stop 時說明原因與恢復點；run_done 時確認預檢和必要審查後執行 sdd run done。不要自行執行 grant add、核准或冒稱 human 的 review write。沒有 SDD run 時照一般對話進行。\n${BOOT_CLOSE}`;

function destFor(platform, route) {
  if (platform === 'claude-code') return `.claude/commands/sdd-${route}.md`;
  if (platform === 'cursor') return `.cursor/rules/sdd-${route}.mdc`;
  return 'AGENTS.md';
}

function skillDest(route) {
  return `.claude/skills/sdd-${route}/SKILL.md`;
}

function sectionOpen(route) {
  return `<!-- sdd-instructions:${route}:start`;
}

function sectionClose(route) {
  return `<!-- sdd-instructions:${route}:end -->`;
}

const DEST = {
  'claude-code': destFor('claude-code', 'direct'),
  cursor: destFor('cursor', 'direct'),
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

function readRuleBlock(file, label) {
  if (!fs.existsSync(file)) throw new BlockedError(`instruction source is missing: ${label}`);
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/<!-- sdd-rule -->\n([\s\S]*?)\n<!-- \/sdd-rule -->/);
  if (!match) throw new BlockedError(`instruction source has no sdd-rule block: ${label}`);
  return match[1];
}

function loadRule(route, root = TOOL_ROOT) {
  if (!ROUTES.includes(route)) throw new UsageError(`--route must be ${ROUTES.join(', ')}`);
  const routeRule = readRuleBlock(path.join(root, 'templates', 'routes', `${route}.md`), `templates/routes/${route}.md`);
  const roles = ROLE_ORDER.map((role) => (
    readRuleBlock(path.join(root, 'templates', 'roles', `${role}.md`), `templates/roles/${role}.md`)
  ));
  return [routeRule, ...roles].join('\n\n');
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
  const description = `Walk one ${route} run`;
  let text;
  if (platform === 'claude-code') {
    text = `---\ndescription: ${description}\nverified: ${verified}\n---\n\n${body}\n`;
  } else if (platform === 'cursor') {
    text = `---\ndescription: ${description}\nalwaysApply: false\nverified: ${verified}\n---\n\n${body}\n`;
  } else {
    text = `${sectionOpen(route)} verified: ${verified} -->\n${body}\n${sectionClose(route)}\n`;
  }
  return {
    platform,
    route,
    dest: destFor(platform, route),
    skill: platform === 'claude-code' ? skillDest(route) : null,
    rule,
    hash,
    verified,
    text,
    skillText: platform === 'claude-code'
      ? `---\nname: sdd-${route}\ndescription: ${description}\nverified: ${verified}\n---\n\n${body}\n`
      : null,
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
  assertSafeTarget(repoRoot, file, 'instructions record');
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
  return assertSafeTarget(repoRoot, abs, rel);
}

function bootstrapSpan(text) {
  const opens = text.split(BOOT_OPEN).length - 1;
  const closes = text.split(BOOT_CLOSE).length - 1;
  if (opens !== closes || opens > 1) throw new BlockedError('CLAUDE.md SDD block is damaged; repair it manually');
  if (!opens) return null;
  const start = text.indexOf(BOOT_OPEN);
  const end = text.indexOf(BOOT_CLOSE, start);
  if (end < start) throw new BlockedError('CLAUDE.md SDD block is damaged; repair it manually');
  return { start, end: end + BOOT_CLOSE.length };
}

function addBootstrap(text) {
  const span = bootstrapSpan(text);
  if (span) return text.slice(0, span.start) + BOOT_TEXT + text.slice(span.end);
  const prefix = text ? (text.endsWith('\n') ? '\n' : '\n\n') : '';
  return `${text}${prefix}${BOOT_TEXT}\n`;
}

function removeBootstrap(text, slot) {
  const span = bootstrapSpan(text);
  if (!span) throw new BlockedError('CLAUDE.md SDD block is missing; repair it manually');
  const prefix = slot.bootstrap_prefix || '';
  const before = text.slice(0, span.start);
  const kept = prefix && before.endsWith(prefix) ? before.slice(0, -prefix.length) : before;
  return kept + text.slice(span.end).replace(/^\n/, '');
}

function spliceSection(original, section, route) {
  const open = sectionOpen(route);
  const close = sectionClose(route);
  const start = original.indexOf(open);
  const end = start === -1 ? -1 : original.indexOf(close, start);
  let base = original;
  if (start !== -1 && end !== -1) {
    base = original.slice(0, start) + original.slice(end + close.length);
  }
  if (base.length === 0) return section;
  const sep = base.endsWith('\n') ? '\n' : '\n\n';
  return `${base}${sep}${section}`;
}

function installedBytes(platform, original, section, route) {
  if (platform === 'codex') {
    if (original && !Buffer.from(original.toString('utf8'), 'utf8').equals(original)) {
      throw new BlockedError('AGENTS.md is not utf-8; refusing to splice');
    }
    return Buffer.from(spliceSection(original ? original.toString('utf8') : '', section, route), 'utf8');
  }
  return Buffer.from(section, 'utf8');
}

function blankFile(existed, originalBase64) {
  return { existed: existed === true, original_base64: originalBase64 || null, routes: [] };
}

function filesOf(record) {
  if (record.files) return record.files;
  const file = blankFile(record.existed, record.original_base64);
  if (record.route) file.routes = [record.route];
  return { [record.path]: file };
}

function writeOwned(repoRoot, rel, bytes) {
  const abs = destination(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function installInto(repoRoot, platform, route, options = {}) {
  const rendered = render(platform, route, options);
  const record = readRecord(repoRoot, platform) || { platform, files: {} };
  const files = filesOf(record);
  destination(repoRoot, rendered.dest);
  if (rendered.skill) destination(repoRoot, rendered.skill);
  destination(repoRoot, recordPath(repoRoot, platform));
  if (platform === 'claude-code') {
    const bootFile = destination(repoRoot, BOOTSTRAP);
    const existing = fs.existsSync(bootFile) ? bootstrapSpan(readUtf8(bootFile, BOOTSTRAP)) : null;
    if (existing && !files[BOOTSTRAP]) throw new BlockedError('CLAUDE.md has an unowned SDD block; repair it manually');
    if (!existing && files[BOOTSTRAP]) throw new BlockedError('CLAUDE.md SDD block is missing; repair it manually');
  }
  const slot = files[rendered.dest] || blankFile(fs.existsSync(destination(repoRoot, rendered.dest)), null);
  if (!slot.original_base64 && slot.existed !== true && fs.existsSync(destination(repoRoot, rendered.dest))) {
    slot.existed = true;
    slot.original_base64 = fs.readFileSync(destination(repoRoot, rendered.dest)).toString('base64');
  }
  if (!files[rendered.dest]) {
    slot.existed = fs.existsSync(destination(repoRoot, rendered.dest));
    slot.original_base64 = slot.existed ? fs.readFileSync(destination(repoRoot, rendered.dest)).toString('base64') : null;
  }
  const current = fs.existsSync(destination(repoRoot, rendered.dest))
    ? fs.readFileSync(destination(repoRoot, rendered.dest))
    : null;
  const base = platform === 'codex' ? current : (slot.original_base64 ? Buffer.from(slot.original_base64, 'base64') : null);
  writeOwned(repoRoot, rendered.dest, installedBytes(platform, base, rendered.text, route));
  if (!slot.routes.includes(route)) slot.routes.push(route);
  files[rendered.dest] = slot;
  if (rendered.skill) {
    const skillAbs = destination(repoRoot, rendered.skill);
    if (!slot.extras) slot.extras = {};
    if (!slot.extras[rendered.skill]) {
      const skillExisted = fs.existsSync(skillAbs);
      slot.extras[rendered.skill] = {
        existed: skillExisted,
        original_base64: skillExisted ? fs.readFileSync(skillAbs).toString('base64') : null,
      };
    }
    writeOwned(repoRoot, rendered.skill, Buffer.from(rendered.skillText, 'utf8'));
  }
  if (platform === 'claude-code') {
    const bootFile = destination(repoRoot, BOOTSTRAP);
    const existed = fs.existsSync(bootFile);
    const current = existed ? readUtf8(bootFile, BOOTSTRAP) : '';
    const boot = files[BOOTSTRAP] || blankFile(existed, existed ? Buffer.from(current).toString('base64') : null);
    if (!boot.routes.length) boot.bootstrap_prefix = current ? (current.endsWith('\n') ? '\n' : '\n\n') : '';
    if (!boot.routes.includes(route)) boot.routes.push(route);
    writeOwned(repoRoot, BOOTSTRAP, Buffer.from(addBootstrap(current), 'utf8'));
    files[BOOTSTRAP] = boot;
  }
  fs.mkdirSync(recordDir(repoRoot), { recursive: true });
  writeJson(recordPath(repoRoot, platform), { platform, files });
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

function restoreBytes(repoRoot, rel, slot) {
  const abs = destination(repoRoot, rel);
  if (slot.existed) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(slot.original_base64, 'base64'));
    return `restored ${rel}`;
  }
  if (fs.existsSync(abs)) {
    fs.unlinkSync(abs);
    removeEmptyParents(abs, repoRoot);
  }
  return `removed ${rel}`;
}

function dropRouteSection(repoRoot, rel, route) {
  const abs = destination(repoRoot, rel);
  if (!fs.existsSync(abs)) return;
  const text = fs.readFileSync(abs, 'utf8');
  const open = sectionOpen(route);
  const close = sectionClose(route);
  const start = text.indexOf(open);
  const end = start === -1 ? -1 : text.indexOf(close, start);
  if (start === -1 || end === -1) return;
  let next = text.slice(0, start) + text.slice(end + close.length);
  next = next.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(abs, next);
}

function restoreOne(repoRoot, platform, route) {
  if (!PLATFORMS.includes(platform)) throw new BlockedError(`unknown instruction platform: ${platform}`);
  const record = readRecord(repoRoot, platform);
  if (!record) return null;
  const files = filesOf(record);
  const allowed = new Set(ROUTES.map((knownRoute) => destFor(platform, knownRoute)));
  if (platform === 'claude-code') allowed.add(BOOTSTRAP);
  if (Object.keys(files).some((rel) => !allowed.has(rel))) {
    throw new BlockedError(`instruction record path is not owned: ${Object.keys(files).join(', ')}`);
  }
  for (const rel of Object.keys(files)) {
    destination(repoRoot, rel);
    const extras = Object.keys(files[rel].extras || {});
    const validExtra = platform === 'claude-code' && ROUTES.some((knownRoute) => (
      rel === destFor(platform, knownRoute) && extras.every((extra) => extra === skillDest(knownRoute))
    ));
    if (extras.length && !validExtra) throw new BlockedError(`instruction record extra is not owned: ${extras.join(', ')}`);
    for (const extra of extras) destination(repoRoot, extra);
    if (rel === BOOTSTRAP) {
      if (!fs.existsSync(destination(repoRoot, rel))) throw new BlockedError('CLAUDE.md SDD block is missing; repair it manually');
      if (!bootstrapSpan(readUtf8(destination(repoRoot, rel), rel))) throw new BlockedError('CLAUDE.md SDD block is missing; repair it manually');
    }
  }
  destination(repoRoot, recordPath(repoRoot, platform));
  const notes = [];
  for (const rel of Object.keys(files)) {
    const slot = files[rel];
    const routes = slot.routes || [];
    if (route && !routes.includes(route)) continue;
    if (!route || routes.filter((item) => item !== route).length === 0) {
      if (rel === BOOTSTRAP) {
        const abs = destination(repoRoot, rel);
        const next = removeBootstrap(readUtf8(abs, rel), slot);
        if (next || slot.existed) fs.writeFileSync(abs, next);
        else { fs.unlinkSync(abs); removeEmptyParents(abs, repoRoot); }
        notes.push(`removed SDD block from ${rel}`);
        delete files[rel];
        continue;
      }
      notes.push(restoreBytes(repoRoot, rel, slot));
      for (const extra of Object.keys(slot.extras || {})) notes.push(restoreBytes(repoRoot, extra, slot.extras[extra]));
      delete files[rel];
      continue;
    }
    slot.routes = routes.filter((item) => item !== route);
    if (rel === 'AGENTS.md') dropRouteSection(repoRoot, rel, route);
    files[rel] = slot;
    notes.push(`removed ${route} from ${rel}`);
  }
  if (route && !notes.length) {
    const known = Object.values(files).flatMap((slot) => slot.routes || []);
    throw new BlockedError(`installed instructions for ${platform} are ${known.join(', ') || 'empty'}`);
  }
  if (!Object.keys(files).length) {
    fs.unlinkSync(recordPath(repoRoot, platform));
    const dir = recordDir(repoRoot);
    if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } else {
    writeJson(recordPath(repoRoot, platform), { platform, files });
  }
  return notes.filter(Boolean).join('; ');
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
