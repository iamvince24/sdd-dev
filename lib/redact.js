'use strict';

// Evidence / export redaction. Distinct from scripts/privacy-check.js, which
// also flags emails, paths, and SSH remotes in the public tool repo.
const PATTERNS = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, to: '[redacted]' },
  { re: /\b(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, to: '[redacted]' },
  { re: /(Authorization:\s*Bearer\s+)\S+/gi, to: '$1[redacted]' },
  { re: /\b(api[_-]?key|client[_-]?secret|access[_-]?token|password|passwd|private[_-]?key)(\s*[:=]\s*)(["'])[^"']*\3/gi, to: '$1$2$3[redacted]$3' },
  { re: /\b(api[_-]?key|client[_-]?secret|access[_-]?token|password|passwd|private[_-]?key)(\s*[:=]\s*)(\S+)/gi, to: '$1$2[redacted]' },
  { re: /^((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*=\s*)(.*)$/gim, to: '$1[redacted]' },
];

function redactString(text) {
  let changed = false;
  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    const next = text.replace(re, pattern.to);
    if (next !== text) changed = true;
    text = next;
  }
  return { text, changed };
}

// latin1 keeps the original bytes for spans we do not rewrite.
function redactBytes(buf) {
  const decoded = redactString(buf.toString('latin1'));
  return { bytes: Buffer.from(decoded.text, 'latin1'), changed: decoded.changed };
}

module.exports = { redactString, redactBytes };
