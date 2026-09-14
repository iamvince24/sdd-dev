#!/usr/bin/env node
'use strict';

// 用法：node scripts/render-html.js <project-dir> [G1|G2|G3|all]
// 例如：node ../../scripts/render-html.js . G2
//
// 把四個 Gate 文件（00-spec.md / 01-plan.md / 02-tasks.md / 03-verify.md）各自轉成
// 同資料夾、同檔名的 .html，方便開瀏覽器 review（表格、checklist 比在終端機／編輯器裡看清楚）。
// 純粹是唯讀衍生檔：只新增／覆蓋 *.html，永遠不讀寫來源 .md 本身；核准、指紋、Gate 判定
// 一律仍然只看 .md —— HTML 壞掉、被誤刪都不影響任何流程狀態，重新跑一次就有，不留歷史版本。
//
// exit code：0 = 至少一個檔案渲染成功；3 = 用法錯誤或 project-dir 不存在。
// 這支不是 Gate 檢查，沒有「blocker」語意，所以不使用 1（見 automation.md 的 exit code 約定）。

const fs = require('fs');
const path = require('path');
const { readFile, fileExists } = require('./lib/md');

const projectDir = process.argv[2] || '.';
const target = (process.argv[3] || 'all').toLowerCase();

const TARGETS = {
  g1: ['00-spec.md'],
  g2: ['01-plan.md', '02-tasks.md'],
  g3: ['03-verify.md'],
  all: ['00-spec.md', '01-plan.md', '02-tasks.md', '03-verify.md'],
};

const files = TARGETS[target];
if (!files) {
  console.error('用法：node render-html.js <project-dir> [G1|G2|G3|all]');
  process.exit(3);
}
if (!fileExists(projectDir)) {
  console.error(`✗ 找不到 ${projectDir}`);
  process.exit(3);
}

// ──────────────────────────────────────────────────────────────────────────
// 極輕量 Markdown → HTML。只服務這四個範本目前實際用到的語法（標題、pipe table、
// 粗體/斜體/行內 code、fenced code block、清單／checklist、blockquote、水平線、連結），
// 不是通用 Markdown parser，也不需要是——內容形狀由 `_template/` 固定。
// ──────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(text, seen) {
  let base = text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
  if (!base) base = 'section';
  let slug = base;
  let n = 2;
  while (seen.has(slug)) slug = `${base}-${n++}`;
  seen.add(slug);
  return slug;
}

// 行內語法：先跳脫 HTML、保護 code span 內容，再處理粗體/斜體/連結，最後還原 code span
// ——順序反過來的話，code span 裡的 `*`、`[`、`]` 會被誤判成粗體/連結語法。
function renderInline(text) {
  let s = escapeHtml(text);
  const codeSpans = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>')
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codeSpans[Number(i)]}</code>`);
  return s;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'));
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const seenSlugs = new Set();
  const toc = [];
  let html = '';
  let i = 0;

  function flushList(items, ordered) {
    const tag = ordered ? 'ol' : 'ul';
    html += `<${tag}>\n`;
    for (const item of items) {
      if (typeof item.checked === 'boolean') {
        html += `<li class="task"><input type="checkbox" disabled ${item.checked ? 'checked' : ''}> ${renderInline(item.text)}</li>\n`;
      } else {
        html += `<li>${renderInline(item.text)}</li>\n`;
      }
    }
    html += `</${tag}>\n`;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // fenced code block
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳過結尾 ```
      html += `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>\n`;
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const slug = slugify(text, seenSlugs);
      if (level <= 3) toc.push({ level, text, slug });
      html += `<h${level} id="${slug}">${renderInline(text)}</h${level}>\n`;
      i++;
      continue;
    }

    // 水平線（純 --- 或 ***；表格分隔列在下面獨立判斷，會先被表格分支攔截）
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }

    // pipe table：這一行含 `|`，下一行是分隔列（--- 或 :--:）才算表格開頭
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && isSeparatorRow(splitRow(lines[i + 1]))) {
      const headerCells = splitRow(line);
      html += '<table>\n<thead>\n<tr>' + headerCells.map((c) => `<th>${renderInline(c.trim())}</th>`).join('') + '</tr>\n</thead>\n<tbody>\n';
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        html += '<tr>' + cells.map((c) => `<td>${renderInline(c.trim())}</td>`).join('') + '</tr>\n';
        i++;
      }
      html += '</tbody>\n</table>\n';
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html += `<blockquote><p>${buf.map(renderInline).join('<br>\n')}</p></blockquote>\n`;
      continue;
    }

    // 清單（無序 -/*、有序 1. 2. …；checklist 的 [ ]/[x] 轉成 disabled checkbox）。
    // 只支援單層，不處理巢狀縮排 —— 這四個範本目前都沒有巢狀清單。
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const ordered = !!ol;
      const items = [];
      while (i < lines.length) {
        const m = ordered ? lines[i].match(/^\s*\d+\.\s+(.*)$/) : lines[i].match(/^\s*[-*]\s+(.*)$/);
        if (!m) break;
        const task = m[1].match(/^\[( |x|X)\]\s+(.*)$/);
        items.push(task ? { checked: task[1].toLowerCase() === 'x', text: task[2] } : { text: m[1] });
        i++;
      }
      flushList(items, ordered);
      continue;
    }

    // 一般段落：連續非空、非其他區塊語法的行合成一段，行與行之間保留原始換行
    const buf = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^#{1,6}\s+/.test(lines[i]) && !/^\s*```/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) && !/^\s*(---+|\*\*\*+)\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length)
    ) {
      buf.push(lines[i]);
      i++;
    }
    html += `<p>${buf.map(renderInline).join('<br>\n')}</p>\n`;
  }

  const tocHtml = toc.length
    ? `<nav class="toc"><strong>目錄</strong><ul>${toc.map((t) => `<li class="toc-l${t.level}"><a href="#${t.slug}">${escapeHtml(t.text)}</a></li>`).join('')}</ul></nav>`
    : '';

  return { body: html, toc: tocHtml };
}

function pageHtml({ title, sourceFile, bodyHtml, tocHtml }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0 auto; max-width: 880px; padding: 2rem 3rem 4rem; background: #fbfaf7; color: #1f2328;
    font-family: -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif;
    line-height: 1.7;
  }
  .banner {
    background: #fff3cd; border: 1px solid #e5c07b; border-radius: 6px;
    padding: .75rem 1rem; margin-bottom: 1.5rem; font-size: .9rem; color: #6b5900;
  }
  .banner code { background: rgba(0,0,0,.06); padding: .1em .3em; border-radius: 4px; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; }
  h1 { border-bottom: 2px solid #d7d2c4; padding-bottom: .4rem; }
  h2 { border-bottom: 1px solid #e5e1d6; padding-bottom: .3rem; margin-top: 2.4rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .92rem; }
  th, td { border: 1px solid #d7d2c4; padding: .5rem .7rem; text-align: left; vertical-align: top; }
  th { background: #f0ede3; }
  tr:nth-child(even) td { background: #f9f8f4; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { background: #f0ede3; padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  pre { background: #282c34; color: #e6e6e6; padding: 1rem; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; color: inherit; }
  blockquote { border-left: 4px solid #d7d2c4; margin: 1rem 0; padding: .2rem 1rem; color: #57606a; }
  li.task { list-style: none; margin-left: -1.4rem; }
  li.task input { margin-right: .4rem; }
  .toc { background: #f5f3ec; border: 1px solid #e5e1d6; border-radius: 6px; padding: 1rem 1.4rem; margin-bottom: 2rem; }
  .toc ul { margin: .4rem 0 0; padding-left: 1.2rem; }
  .toc-l1 { font-weight: 600; }
  .toc-l2 { margin-left: .8rem; }
  .toc-l3 { margin-left: 1.6rem; font-size: .92rem; }
  a { color: #0969da; }
  hr { border: none; border-top: 1px solid #d7d2c4; margin: 2rem 0; }
</style>
</head>
<body>
<div class="banner">📄 這是 <code>${escapeHtml(sourceFile)}</code> 的唯讀渲染，僅供閱讀方便。
內容以 <code>${escapeHtml(sourceFile)}</code> 為準，本檔為自動產生，請勿手動編輯。</div>
${tocHtml}
${bodyHtml}
</body>
</html>
`;
}

let successCount = 0;

for (const file of files) {
  const srcPath = path.join(projectDir, file);
  const outPath = srcPath.replace(/\.md$/, '.html');
  if (!fileExists(srcPath)) {
    console.error(`⚠ 找不到 ${srcPath}，略過`);
    continue;
  }
  try {
    const md = readFile(srcPath);
    const { body, toc } = renderMarkdown(md);
    const title = `${path.basename(path.resolve(projectDir))} — ${file}`;
    const html = pageHtml({ title, sourceFile: file, bodyHtml: body, tocHtml: toc });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`✓ ${srcPath} → ${outPath}`);
    successCount++;
  } catch (e) {
    console.error(`⚠ ${srcPath} 渲染失敗：${e.message}`);
  }
}

if (successCount === 0) {
  console.error('沒有任何檔案渲染成功。');
  process.exit(3);
}
process.exit(0);
