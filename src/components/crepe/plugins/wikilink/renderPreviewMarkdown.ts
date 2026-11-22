/**
 * Wikilink hover 预览卡片的富文本 Markdown + KaTeX 渲染器。
 *
 * 目标：
 * - 轻量、同步、零重型 AST 开销，截取前 ~2500 字符保证大笔记悬停即开。
 * - 支持标题、粗/斜体、删除线、行内代码、==高亮==、[[双链|别名]]、Markdown 链接、
 *   引用块、无序/有序/任务列表、围栏代码块、分隔线、简易表格及行内/块级 KaTeX 公式。
 * - 自动剥离 frontmatter 与 `<!-- ds:block-id=... -->` 等内部技术注释。
 * - 所有输出最终均经 DOMPurify 清洗，防御 XSS。
 */

import DOMPurify from 'dompurify';
import katex from 'katex';

import { parseWikiLinkInner } from './format';

export const DEFAULT_PREVIEW_MAX_CHARS = 2500;

export interface RenderPreviewMarkdownOptions {
  /** 最大渲染字符数，避免超大笔记阻塞悬停渲染 */
  maxChars?: number;
}

const MAX_BLOCKQUOTE_DEPTH = 6;
const PLACEHOLDER_PREFIX = '\uE000DS_PREV_';
const PLACEHOLDER_SUFFIX = '\uE001';

const PURIFY_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_ATTR: ['target', 'rel', 'aria-hidden', 'data-checked', 'encoding'],
  FORBID_TAGS: [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'textarea',
    'select',
    'button',
    'img',
    'video',
    'audio',
    'picture',
    'source',
  ],
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

function renderKatex(tex: string, displayMode: boolean): string {
  const trimmed = tex.trim();
  if (!trimmed) return '';
  try {
    return katex.renderToString(trimmed, {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    return `<code>${escapeHtml(trimmed)}</code>`;
  }
}

/** 剥离文档开头的 YAML frontmatter（含可选 BOM） */
function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n(?:[\s\S]*?\n)?---(?:\n|$)/.exec(normalized);
  return match ? normalized.slice(match[0].length) : normalized;
}

/** 在行边界安全截断，并补齐或回退未闭合的代码围栏 / 块级公式 */
function truncatePreviewSource(
  text: string,
  maxChars: number,
): { source: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { source: text, truncated: false };
  }

  let cut = maxChars;
  const lastNewline = text.lastIndexOf('\n', maxChars);
  if (lastNewline > maxChars - 300 && lastNewline > 0) {
    cut = lastNewline;
  }

  let slice = text.slice(0, cut);
  const lines = slice.split('\n');

  let fence: { char: string; len: number } | null = null;
  let mathStartLine = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      const closeMatch = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closeMatch && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.len) {
        fence = null;
      }
      continue;
    }

    if (mathStartLine !== -1) {
      if (/^ {0,3}\$\$\s*$/.test(line) || line.trimEnd().endsWith('$$')) {
        mathStartLine = -1;
      }
      continue;
    }

    const openFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (openFence) {
      fence = { char: openFence[1][0], len: openFence[1].length };
      continue;
    }

    if (/^ {0,3}\$\$/.test(line) && !/^ {0,3}\$\$.+\$\$\s*$/.test(line)) {
      mathStartLine = i;
    }
  }

  if (mathStartLine === 0) {
    return { source: '…', truncated: true };
  }
  if (mathStartLine !== -1) {
    slice = lines.slice(0, mathStartLine).join('\n');
  } else if (fence) {
    slice = `${slice}\n${fence.char.repeat(fence.len)}`;
  }

  return { source: slice, truncated: true };
}

/** 仅放行安全的外部/邮件协议，其余链接以样式化 span 呈现，避免误跳转或脚本协议 */
function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  return /^(?:https?:|mailto:)/i.test(trimmed);
}

/** 扫描并替换行内公式 `$...$` 与 `$$...$$`，跳过 `\$` 转义并避开货币金额 */
function replaceInlineMath(
  text: string,
  stash: (html: string) => string,
): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    // 裸 \$ 转义：保留字面 `$`，不开启数学公式
    if (text[i] === '\\' && text[i + 1] === '$') {
      out += stash('$');
      i += 2;
      continue;
    }

    if (text[i] === '$') {
      // 行内双美元 $$...$$
      if (text[i + 1] === '$') {
        let j = i + 2;
        let found = -1;
        while (j < text.length && text[j] !== '\n') {
          if (text[j] === '\\' && j + 1 < text.length) {
            j += 2;
            continue;
          }
          if (text[j] === '$' && text[j + 1] === '$') {
            found = j;
            break;
          }
          j += 1;
        }
        if (found > i + 2) {
          const expr = text.slice(i + 2, found);
          out += stash(renderKatex(expr, true));
          i = found + 2;
          continue;
        }
        out += '$$';
        i += 2;
        continue;
      }

      // 行内单美元 $...$（Pandoc/Obsidian 规则：开头后非空白、结尾前非空白、结尾后非数字/美元）
      const nextChar = text[i + 1];
      if (nextChar && !/\s/.test(nextChar)) {
        let j = i + 1;
        let found = -1;
        while (j < text.length && text[j] !== '\n') {
          if (text[j] === '\\' && j + 1 < text.length) {
            j += 2;
            continue;
          }
          if (text[j] === '$') {
            const prevChar = text[j - 1];
            const afterChar = text[j + 1] ?? '';
            if (j > i + 1 && prevChar && !/\s/.test(prevChar) && !/[$\d]/.test(afterChar)) {
              found = j;
            }
            break;
          }
          j += 1;
        }
        if (found !== -1) {
          const expr = text.slice(i + 1, found);
          out += stash(renderKatex(expr, false));
          i = found + 1;
          continue;
        }
      }
    }

    out += text[i];
    i += 1;
  }

  return out;
}

/** CommonMark 行内代码扫描：正确支持双/多反引号包裹内部反引号（如 ``foo `bar` ``） */
function replaceInlineCodeSpans(
  text: string,
  stash: (html: string) => string,
): string {
  if (!text.includes('`')) return text;
  const n = text.length;
  let out = '';
  let i = 0;

  while (i < n) {
    if (text[i] !== '`') {
      out += text[i];
      i += 1;
      continue;
    }

    let openEnd = i;
    while (openEnd < n && text[openEnd] === '`') openEnd += 1;
    const tickLen = openEnd - i;

    let j = openEnd;
    let closeStart = -1;
    let closeEnd = -1;
    while (j < n && text[j] !== '\n') {
      if (text[j] === '`') {
        let runEnd = j;
        while (runEnd < n && text[runEnd] === '`') runEnd += 1;
        if (runEnd - j === tickLen) {
          closeStart = j;
          closeEnd = runEnd;
          break;
        }
        j = runEnd;
        continue;
      }
      j += 1;
    }

    if (closeStart > openEnd) {
      let code = text.slice(openEnd, closeStart);
      if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) {
        code = code.slice(1, -1);
      }
      out += stash(`<code>${escapeHtml(code)}</code>`);
      i = closeEnd;
      continue;
    }

    out += text.slice(i, openEnd);
    i = openEnd;
  }

  return out;
}

/** 渲染行内 Markdown + KaTeX */
function renderInline(raw: string): string {
  if (!raw) return '';

  // 清除输入中可能碰巧出现的私用区占位符前缀，避免伪造占位替换
  let text = raw.replace(/\uE000|\uE001/g, '');
  const tokens: string[] = [];
  const stash = (html: string): string => {
    const idx = tokens.length;
    tokens.push(html);
    return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_SUFFIX}`;
  };

  // 1. 优先保护行内代码（支持 ``code`` 与 `code`），内部不做公式/注释/格式解析
  text = replaceInlineCodeSpans(text, stash);

  // 2. 剥离行内 HTML 注释（含 <!-- ds:block-id=... -->）
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 3. 解析行内 KaTeX 数学公式（同时处理 \$ 转义）
  text = replaceInlineMath(text, stash);

  // 4. 保护其余常见反斜杠转义，避免触发粗斜体/高亮/链接
  text = text.replace(/\\([\\*_~=[\]`<>])/g, (_m, ch: string) => stash(escapeHtml(ch)));

  // 5. 内联 wikilink：[[Target|Alias]] / [[Target]] / ![[Embed]]
  text = text.replace(/!?\[\[([^\]\r\n]+?)\]\]/g, (_m, inner: string) => {
    const parsed = parseWikiLinkInner(inner);
    if (!parsed) return escapeHtml(_m);
    const display = parsed.label || parsed.target;
    return stash(`<span class="crepe-preview-wikilink">${escapeHtml(display)}</span>`);
  });

  // 6. 图片 ![alt](url) -> 轻量徽章，避免悬停卡片中加载外部大图导致抖动
  text = text.replace(/!\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g, (_m, alt: string) => {
    const label = alt.trim() || 'Image';
    return stash(`<span class="crepe-preview-image-badge">${escapeHtml(label)}</span>`);
  });

  // 7. Markdown 链接 [label](url)（支持 URL 内单层成对括号，如 Wikipedia 链接）
  text = text.replace(
    /\[([^\]\r\n]+)\]\(((?:[^()\r\n]|\([^()\r\n]*\))+)\)/g,
    (_m, label: string, rawDest: string) => {
      const dest = rawDest.trim().replace(/\s+["'][^"']*["']$/, '').replace(/^<|>$/g, '');
      const renderedLabel = renderInlineSimpleFormatting(label.replace(/<(?![a-zA-Z/])/g, '&lt;'));
      if (isSafeLinkHref(dest)) {
        return stash(
          `<a class="crepe-preview-link" href="${escapeAttr(dest)}" target="_blank" rel="noopener noreferrer">${renderedLabel}</a>`,
        );
      }
      return stash(`<span class="crepe-preview-link">${renderedLabel}</span>`);
    },
  );

  // 8. 保护普通文本中的孤立 `<`（如 `a < b`），保留 HTML 标签供 DOMPurify 清洗
  text = text.replace(/<(?![a-zA-Z/])/g, '&lt;');

  // 9. 行内强调 / 高亮 / 删除线
  text = renderInlineSimpleFormatting(text);

  // 10. 还原占位符（支持嵌套占位）
  const restorePattern = new RegExp(
    `${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`,
    'g',
  );
  let passes = 0;
  while (text.includes(PLACEHOLDER_PREFIX) && passes < 4) {
    text = text.replace(restorePattern, (_m, idx: string) => tokens[Number(idx)] ?? '');
    passes += 1;
  }

  return text;
}

function renderInlineSimpleFormatting(input: string): string {
  let text = input;
  // ==highlight==（避开 === / ==== 等连续等号误匹配，同时保留内部单个 = 如 ==E = mc^2==）
  text = text.replace(
    /(?<!=)==(?!=)(?=\S)((?:(?!==).)+?)(?<=\S)(?<!=)==(?!=)/g,
    '<mark class="crepe-preview-mark">$1</mark>',
  );
  // ***bold italic***
  text = text.replace(
    /\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g,
    '<strong><em>$1</em></strong>',
  );
  // **bold** / __bold__
  text = text.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])/g, '<strong>$1</strong>');
  // *italic* / _italic_
  text = text.replace(/(?<!\*)\*(?!\*|\s)(.+?)(?<!\s|\*)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/(?<![\w])_(?!_|\s)(.+?)(?<!\s|_)_(?![\w])/g, '<em>$1</em>');
  // ~~strikethrough~~
  text = text.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>');
  return text;
}

interface ParsedListItem {
  indent: number;
  ordered: boolean;
  isTask: boolean;
  checked: boolean;
  text: string;
}

function parseListItemLine(line: string): ParsedListItem | null {
  const taskMatch = /^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line);
  if (taskMatch) {
    return {
      indent: taskMatch[1].replace(/\t/g, '  ').length,
      ordered: false,
      isTask: true,
      checked: taskMatch[2].toLowerCase() === 'x',
      text: taskMatch[3],
    };
  }

  const bulletMatch = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bulletMatch) {
    return {
      indent: bulletMatch[1].replace(/\t/g, '  ').length,
      ordered: false,
      isTask: false,
      checked: false,
      text: bulletMatch[2],
    };
  }

  const orderedMatch = /^(\s*)\d+\.\s+(.*)$/.exec(line);
  if (orderedMatch) {
    return {
      indent: orderedMatch[1].replace(/\t/g, '  ').length,
      ordered: true,
      isTask: false,
      checked: false,
      text: orderedMatch[2],
    };
  }

  return null;
}

function renderListItems(items: ParsedListItem[]): string {
  const renderLevel = (startIdx: number, baseIndent: number): { html: string; nextIdx: number } => {
    const first = items[startIdx];
    const ordered = first.ordered;
    const tag = ordered ? 'ol' : 'ul';

    const siblings: { item: ParsedListItem; childrenHtml: string }[] = [];
    let i = startIdx;

    while (i < items.length) {
      const current = items[i];
      if (current.indent < baseIndent) break;
      if (current.indent === baseIndent && current.ordered !== ordered) break;

      if (current.indent > baseIndent) {
        const sub = renderLevel(i, current.indent);
        if (siblings.length > 0) {
          siblings[siblings.length - 1].childrenHtml += sub.html;
        }
        i = sub.nextIdx;
        continue;
      }

      siblings.push({ item: current, childrenHtml: '' });
      i += 1;

      while (i < items.length && items[i].indent > baseIndent) {
        const sub = renderLevel(i, items[i].indent);
        siblings[siblings.length - 1].childrenHtml += sub.html;
        i = sub.nextIdx;
      }
    }

    const allTasks = !ordered && siblings.length > 0 && siblings.every((s) => s.item.isTask);
    const listClass = allTasks ? ' class="crepe-preview-task-list"' : '';

    const itemsHtml = siblings
      .map(({ item, childrenHtml }) => {
        if (item.isTask) {
          const checkedClass = item.checked ? ' crepe-preview-task-item--checked' : '';
          const checkedAttr = item.checked ? 'true' : 'false';
          return `<li class="crepe-preview-task-item${checkedClass}"><span class="crepe-preview-task-box" data-checked="${checkedAttr}" aria-hidden="true"></span><span class="crepe-preview-task-text">${renderInline(item.text)}${childrenHtml}</span></li>`;
        }
        return `<li>${renderInline(item.text)}${childrenHtml}</li>`;
      })
      .join('');

    return { html: `<${tag}${listClass}>${itemsHtml}</${tag}>`, nextIdx: i };
  };

  let html = '';
  let idx = 0;
  while (idx < items.length) {
    const result = renderLevel(idx, items[idx].indent);
    html += result.html;
    idx = result.nextIdx;
  }
  return html;
}

const TABLE_SEP_RE = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isHorizontalRule(line: string): boolean {
  return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isBlockStarter(lines: string[], index: number): boolean {
  const line = lines[index];
  if (!line.trim()) return true;
  if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}\$\$/.test(line)) return true;
  if (/^ {0,3}#{1,6}\s+/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^\s*<!--/.test(line)) return true;
  if (isHorizontalRule(line)) return true;
  if (parseListItemLine(line)) return true;
  if (
    line.includes('|') &&
    index + 1 < lines.length &&
    TABLE_SEP_RE.test(lines[index + 1])
  ) {
    return true;
  }
  return false;
}

function renderBlocks(lines: string[], depth = 0): string {
  const htmlParts: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 独立/多行 HTML 注释（含 <!-- ds:block-id=... -->）
    if (/^\s*<!--/.test(line)) {
      let rest = line;
      while (i < lines.length && !rest.includes('-->')) {
        i += 1;
        rest = lines[i] ?? '';
      }
      const closeIdx = rest.indexOf('-->');
      const trailing = closeIdx !== -1 ? rest.slice(closeIdx + 3).trim() : '';
      i += 1;
      if (trailing) {
        const renderedTrailing = renderInline(trailing).trim();
        if (renderedTrailing) htmlParts.push(`<p>${renderedTrailing}</p>`);
      }
      continue;
    }

    // 围栏代码块 ``` / ~~~
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2].trim().split(/\s+/)[0]?.replace(/[^a-zA-Z0-9_-]/g, '') ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const closeMatch = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      const langAttr = lang ? ` class="language-${escapeAttr(lang)}"` : '';
      htmlParts.push(
        `<pre class="crepe-preview-code-block"><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // 单行块级公式 $$...$$
    const singleMath = /^ {0,3}\$\$(.+?)\$\$\s*$/.exec(line);
    if (singleMath) {
      const rendered = renderKatex(singleMath[1], true);
      if (rendered) {
        htmlParts.push(`<div class="crepe-preview-math-block">${rendered}</div>`);
      }
      i += 1;
      continue;
    }

    // 多行块级公式 $$\n...\n$$
    if (/^ {0,3}\$\$/.test(line)) {
      const firstLineRest = line.replace(/^ {0,3}\$\$/, '');
      const mathLines: string[] = [];
      if (firstLineRest.trim()) mathLines.push(firstLineRest);
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (/^ {0,3}\$\$\s*$/.test(lines[j])) {
          closed = true;
          j += 1;
          break;
        }
        if (lines[j].trimEnd().endsWith('$$')) {
          const tail = lines[j].trimEnd().slice(0, -2);
          if (tail) mathLines.push(tail);
          closed = true;
          j += 1;
          break;
        }
        mathLines.push(lines[j]);
        j += 1;
      }
      if (closed) {
        const rendered = renderKatex(mathLines.join('\n'), true);
        if (rendered) {
          htmlParts.push(`<div class="crepe-preview-math-block">${rendered}</div>`);
        }
        i = j;
        continue;
      }
    }

    // 标题 #..######
    const headingMatch = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const body = renderInline(headingMatch[2]).trim();
      if (body) {
        htmlParts.push(`<h${level}>${body}</h${level}>`);
      }
      i += 1;
      continue;
    }

    // 分隔线
    if (isHorizontalRule(line)) {
      htmlParts.push('<hr />');
      i += 1;
      continue;
    }

    // 引用块 > ...
    if (/^ {0,3}>/.test(line) && depth < MAX_BLOCKQUOTE_DEPTH) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i += 1;
      }
      const inner = renderBlocks(quoteLines, depth + 1);
      if (inner) {
        htmlParts.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }

    // GFM 表格
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1])
    ) {
      const headerCells = splitTableRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headerCells.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`;
      const tbody =
        bodyRows.length > 0
          ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
          : '';
      htmlParts.push(`<table class="crepe-preview-table">${thead}${tbody}</table>`);
      continue;
    }

    // 列表（无序 / 有序 / 任务列表，支持嵌套缩进）
    const firstListItem = parseListItemLine(line);
    if (firstListItem) {
      const listItems: ParsedListItem[] = [firstListItem];
      i += 1;
      while (i < lines.length) {
        const nextItem = parseListItemLine(lines[i]);
        if (nextItem) {
          listItems.push(nextItem);
          i += 1;
          continue;
        }
        // 列表项之间的独立内部注释行直接跳过，不断裂列表
        if (/^\s*<!--[\s\S]*?-->\s*$/.test(lines[i])) {
          i += 1;
          continue;
        }
        break;
      }
      htmlParts.push(renderListItems(listItems));
      continue;
    }

    // 普通段落
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length && !isBlockStarter(lines, i)) {
      paraLines.push(lines[i]);
      i += 1;
    }
    const renderedLines = paraLines
      .map((l) => renderInline(l).trimEnd())
      .filter((l) => l.length > 0);
    if (renderedLines.length > 0) {
      htmlParts.push(`<p>${renderedLines.join('<br />')}</p>`);
    }
  }

  return htmlParts.join('');
}

/** 在 DOMPurify 清洗前将原始 HTML `<img ...>` 转为纯文本徽章，避免外部资源请求与布局抖动 */
function replaceRawImgTags(html: string): string {
  return html.replace(/<img\b([^>]*?)\/?>/gi, (_match, attrs: string) => {
    const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs);
    const rawAlt = (altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? '').trim();
    const label = rawAlt || 'Image';
    return `<span class="crepe-preview-image-badge">${escapeHtml(label)}</span>`;
  });
}

/** 校验所有保留的 `<a>` 协议安全性，并统一补齐 `target="_blank" rel="noopener noreferrer"` */
function enforceSafeLinks(sanitizedHtml: string): string {
  if (!sanitizedHtml.includes('<a') && !sanitizedHtml.includes('<A')) {
    return sanitizedHtml;
  }
  if (typeof document === 'undefined') {
    return sanitizedHtml;
  }
  const container = document.createElement('div');
  container.innerHTML = sanitizedHtml;
  const anchors = Array.from(container.querySelectorAll('a'));
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') ?? '';
    if (!isSafeLinkHref(href)) {
      const span = document.createElement('span');
      span.className = 'crepe-preview-link';
      while (anchor.firstChild) {
        span.appendChild(anchor.firstChild);
      }
      anchor.replaceWith(span);
    } else {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return container.innerHTML;
}

/**
 * 将笔记 Markdown 渲染为经过 DOMPurify 清洗的富文本预览 HTML。
 * 内容为空（或仅含 frontmatter / 内部注释）时返回空字符串 `''`。
 */
export function renderPreviewMarkdown(
  markdown: string,
  options: RenderPreviewMarkdownOptions = {},
): string {
  if (!markdown) return '';
  const maxChars = options.maxChars ?? DEFAULT_PREVIEW_MAX_CHARS;
  const withoutFrontmatter = stripFrontmatter(markdown).trim();
  if (!withoutFrontmatter) return '';

  const { source, truncated } = truncatePreviewSource(withoutFrontmatter, maxChars);
  let rawHtml =
    truncated && source === '…'
      ? '<p class="crepe-preview-ellipsis" aria-hidden="true">…</p>'
      : renderBlocks(source.split('\n'));
  if (!rawHtml.trim()) {
    if (!truncated) return '';
    rawHtml = '<p class="crepe-preview-ellipsis" aria-hidden="true">…</p>';
  } else if (truncated && source !== '…') {
    rawHtml += '<p class="crepe-preview-ellipsis" aria-hidden="true">…</p>';
  }

  const normalizedHtml = replaceRawImgTags(rawHtml);
  const sanitized = enforceSafeLinks(DOMPurify.sanitize(normalizedHtml, PURIFY_CONFIG).trim()).trim();
  if (!sanitized || !sanitized.replace(/<\/?(?:p|br\s*\/?)>/gi, '').trim()) {
    return '';
  }
  return sanitized;
}
