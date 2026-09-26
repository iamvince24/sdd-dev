#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const toolRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const configPath = path.join(toolRoot, 'sdd-dev.local.json');

function git(args) {
  return spawnSync('git', args, { cwd: toolRoot, encoding: 'utf8' });
}

function nulList(args) {
  const result = spawnSync('git', args, { cwd: toolRoot, encoding: 'buffer' });
  if (result.status !== 0) {
    console.error((result.stderr || Buffer.alloc(0)).toString('utf8').trim() || 'git command failed');
    process.exit(3);
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function loadLocalPrivacy() {
  if (!fs.existsSync(configPath)) return { markers: [], emailDomains: [] };
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`Invalid local config: ${error.message}`);
    process.exit(3);
  }
  const privacy = config.privacy && typeof config.privacy === 'object' ? config.privacy : {};
  const configuredMarkers = Array.isArray(privacy.privateMarkers) ? privacy.privateMarkers : [];
  const configuredDomains = Array.isArray(privacy.privateEmailDomains) ? privacy.privateEmailDomains : [];
  return {
    markers: [...new Set(configuredMarkers)]
      .map(String).map((value) => value.trim()).filter((value) => value.length >= 3),
    emailDomains: [...new Set(configuredDomains)]
      .map(String).map((value) => value.toLowerCase().trim()).filter(Boolean),
  };
}

const tracked = nulList(['ls-files', '--cached', '-z']);
const candidates = nulList(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
const localPrivacy = loadLocalPrivacy();
const problems = [];

const forbiddenTracked = tracked.filter((file) =>
  /^\.sdd-dev\/runs\/|(?:^|\/)\.env(?:\.|$)|\.local\.json$/i.test(file)
);
for (const file of forbiddenTracked) problems.push(`${file}: local/private artifact is tracked`);

const genericPatterns = [
  { label: 'email address', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: 'Git SSH remote', re: /\bgit@[A-Z0-9.-]+:[^\s]+/i },
  { label: 'personal absolute path', re: /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/i },
  { label: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'credential-like assignment', re: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|passwd|private[_-]?key)\s*[:=]\s*["'][^"']+["']/i },
  { label: 'common secret token', re: /\b(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/ },
];

for (const file of candidates) {
  const absolute = path.join(toolRoot, file);
  let bytes;
  try {
    bytes = fs.readFileSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    problems.push(`${file}: cannot read (${error.message})`);
    continue;
  }
  if (bytes.includes(0)) {
    problems.push(`${file}: contains NUL bytes; binary/unscannable files are not allowed in the public tree`);
    continue;
  }
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const pattern of genericPatterns) {
      if (pattern.re.test(line)) problems.push(`${file}:${index + 1}: ${pattern.label}`);
    }
    for (const marker of localPrivacy.markers) {
      if (line.toLowerCase().includes(marker.toLowerCase())) {
        problems.push(`${file}:${index + 1}: matches a private marker from local configuration`);
      }
    }
  }
}

const identity = git(['config', '--get', 'user.email']);
const email = (identity.stdout || '').trim().toLowerCase();
for (const domain of localPrivacy.emailDomains) {
  if (email.endsWith(`@${domain}`)) {
    problems.push('Git author email matches a private company domain from local configuration');
  }
}

console.log(`Public-tree privacy check — ${toolRoot}\n`);
console.log(`Scanned ${candidates.length} tracked or unignored candidate files.`);
if (problems.length > 0) {
  for (const problem of [...new Set(problems)]) console.log(`✗ ${problem}`);
  console.log('\nNot safe to commit. Keep project data local or replace it with a fictional, generic example.');
  process.exit(1);
}
console.log('✓ No forbidden local artifacts, private markers, personal paths, credentials, or unscannable files found.');
process.exit(0);
