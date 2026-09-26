'use strict';

const fs = require('fs');
const path = require('path');

function recordRedaction(runDir, where) {
  const file = path.join(runDir, 'problems.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const nums = [...existing.matchAll(/^## P-(\d+)/gm)].map((match) => Number(match[1]));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  const entry = [
    `## P-${n}`,
    `- 影響: ${where} 含憑證形狀`,
    '- 處理: 已改寫為 [redacted]',
    '- 理由: 秘密不進 runs',
    '- 結果: redacted',
    '- 阻塞下游: false',
    '',
  ].join('\n');
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}${entry}`);
}

module.exports = { recordRedaction };
