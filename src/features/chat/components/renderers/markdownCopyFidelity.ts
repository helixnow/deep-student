import React from 'react';
import type { ReactNode } from 'react';

const CHROME_SELECTOR = [
  '.code-block-sticky-header',
  '.code-block-header',
  '.os-scrollbar',
  '.os-size-observer',
  '.os-trinsic-observer',
  '[data-decoration="true"]',
  'button.code-block-copy',
].join(', ');

const COPY_RELEVANT_SELECTOR = [
  '.katex',
  '.katex-display',
  '.katex-mathml',
  '.katex-html',
  '.code-block-wrapper',
  '.code-block-header',
  '.code-block-sticky-header',
  '.table-wrapper',
  'table.markdown-table',
].join(', ');

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'UL',
]);

const PLAINTEXT_LANGS = new Set(['', 'text', 'plain', 'plaintext']);

/**
 * Recursively extracts plain text from any ReactNode (including search-highlight
 * `<mark>` elements inside code blocks) so CodeBlock copy/render never leaks
 * `[object Object]`.
 */
export function extractTextFromReactNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromReactNode).join('');
  }
  if (React.isValidElement(node)) {
    const props = node.props as { children?: ReactNode } | undefined;
    return extractTextFromReactNode(props?.children);
  }
  return '';
}

/**
 * Extracts raw TeX source from a KaTeX DOM container via its MathML `<annotation>`.
 */
export function extractLatexFromKatexElement(element: Element): string | null {
  const annotation =
    element.querySelector('annotation[encoding="application/x-tex"]') ??
    element.querySelector('annotation');
  const tex = annotation?.textContent?.trim();
  return tex ? tex : null;
}

/**
 * Formats extracted TeX source as clean Markdown/LaTeX (`$...$` or `$$...$$`).
 */
export function formatLatexForCopy(tex: string, displayMode: boolean): string {
  const cleaned = tex.trim();
  if (!cleaned) return '';
  if (displayMode) {
    return cleaned.includes('\n') ? `$$\n${cleaned}\n$$` : `$$${cleaned}$$`;
  }
  return `$${cleaned}$`;
}

function closestKatexContainer(node: Node | null): Element | null {
  if (!node) return null;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return null;
  return el.closest('.katex-display') ?? el.closest('.katex');
}

function detectCodeBlockLanguage(wrapper: Element): string {
  const langLabel = wrapper.querySelector('.code-block-lang')?.textContent?.trim().toLowerCase() ?? '';
  if (langLabel && !PLAINTEXT_LANGS.has(langLabel)) {
    return langLabel;
  }
  const codeEl = wrapper.querySelector('pre code') ?? wrapper.querySelector('code');
  const className = codeEl?.getAttribute('class') ?? '';
  const match = className.match(/\blanguage-([^\s]+)/i);
  const detected = match?.[1]?.trim().toLowerCase() ?? '';
  return PLAINTEXT_LANGS.has(detected) ? '' : detected;
}

function formatTableAsMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const matrix = rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) =>
      (cell.textContent ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\s*\n\s*/g, ' ')
        .trim()
        .replace(/\|/g, '\\|'),
    ),
  );

  const colCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  if (colCount === 0) return '';

  const normalizeRow = (cells: string[]) => {
    const padded = cells.slice();
    while (padded.length < colCount) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };

  const hasHeader =
    table.querySelector('thead tr') !== null ||
    rows[0].querySelector('th') !== null;

  const lines: string[] = [normalizeRow(matrix[0])];
  if (hasHeader) {
    lines.push(`| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`);
    for (let i = 1; i < matrix.length; i += 1) {
      lines.push(normalizeRow(matrix[i]));
    }
  } else {
    for (let i = 1; i < matrix.length; i += 1) {
      lines.push(normalizeRow(matrix[i]));
    }
  }
  return lines.join('\n');
}

function isWrapperContainerDiv(el: Element): boolean {
  if (el.tagName !== 'DIV') return false;
  return (
    el.hasAttribute('data-slot') ||
    el.hasAttribute('data-overlayscrollbars') ||
    el.hasAttribute('data-overlayscrollbars-viewport') ||
    el.classList.contains('markdown-content') ||
    el.classList.contains('blocked-markdown') ||
    el.classList.contains('streaming-block-renderer') ||
    el.classList.contains('streaming-blocks') ||
    el.classList.contains('streaming-markdown') ||
    el.classList.contains('normal-content') ||
    el.classList.contains('main-content') ||
    el.classList.contains('stream-block') ||
    el.classList.contains('table-wrapper') ||
    el.classList.contains('code-block-body-shell') ||
    el.classList.contains('math-scroll-area')
  );
}

function serializeNodeToMarkdownText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const el = node as Element;
  const tag = el.tagName;

  if (tag === 'BR') {
    return '\n';
  }
  if (tag === 'HR') {
    return '\n\n---\n\n';
  }
  if (el.getAttribute('data-copy-markdown-block') === 'true') {
    return `\n\n${el.textContent ?? ''}\n\n`;
  }
  if (tag === 'PRE') {
    const text = (el.textContent ?? '').replace(/\n$/, '');
    return `\n\n${text}\n\n`;
  }

  const childParts = Array.from(el.childNodes).map(serializeNodeToMarkdownText);
  const joined = childParts.join('');

  if (tag === 'LI') {
    return `${joined.trim()}\n`;
  }
  if (tag === 'TR') {
    return `${joined.trim()}\n`;
  }
  if (tag === 'TH' || tag === 'TD') {
    return `${joined.trim()}\t`;
  }

  if (isWrapperContainerDiv(el)) {
    const trimmed = joined.replace(/^\n+|\n+$/g, '');
    if (!trimmed) return '';
    return el.classList.contains('stream-block') ||
      el.classList.contains('markdown-content') ||
      el.classList.contains('math-scroll-area') ||
      el.classList.contains('table-wrapper')
      ? `\n\n${trimmed}\n\n`
      : joined;
  }

  if (BLOCK_TAGS.has(tag)) {
    const trimmed = joined.replace(/^\n+|\n+$/g, '');
    return trimmed ? `\n\n${trimmed}\n\n` : '';
  }

  return joined;
}

/**
 * Transforms a cloned DOM selection fragment into clean raw Markdown/LaTeX
 * (`$...$`, `$$...$$`, fenced code blocks, Markdown tables) with zero KaTeX
 * MathML/HTML duplication and zero code-block toolbar noise.
 */
export function serializeSelectionFragmentToMarkdown(
  fragment: DocumentFragment,
  ownerDoc: Document = document,
): { plainText: string; html: string } {
  // Capture language labels before stripping code-block headers.
  const codeBlockWrappers = Array.from(fragment.querySelectorAll('.code-block-wrapper'));
  const wrapperLanguages = new WeakMap<Element, string>();
  for (const wrapper of codeBlockWrappers) {
    wrapperLanguages.set(wrapper, detectCodeBlockLanguage(wrapper));
  }

  // Remove non-content UI chrome (headers, buttons, overlay scrollbars).
  for (const chrome of Array.from(fragment.querySelectorAll(CHROME_SELECTOR))) {
    chrome.remove();
  }

  // Snapshot cleaned HTML before replacing KaTeX/code nodes with plain-text markers.
  const html = Array.from(fragment.childNodes)
    .map((child) => (child.nodeType === Node.TEXT_NODE ? child.textContent ?? '' : (child as Element).outerHTML ?? ''))
    .join('');

  // Replace display math blocks first so they get `$$...$$` delimiters.
  for (const displayEl of Array.from(fragment.querySelectorAll('.katex-display'))) {
    const tex = extractLatexFromKatexElement(displayEl);
    if (tex) {
      const marker = ownerDoc.createElement('div');
      marker.setAttribute('data-copy-markdown-block', 'true');
      marker.textContent = formatLatexForCopy(tex, true);
      displayEl.replaceWith(marker);
    } else {
      displayEl.querySelectorAll('.katex-mathml').forEach((n) => n.remove());
    }
  }

  // Replace remaining inline KaTeX formulas with `$...$`.
  for (const katexEl of Array.from(fragment.querySelectorAll('.katex'))) {
    const tex = extractLatexFromKatexElement(katexEl);
    if (tex) {
      katexEl.replaceWith(ownerDoc.createTextNode(formatLatexForCopy(tex, false)));
    } else {
      katexEl.querySelectorAll('.katex-mathml').forEach((n) => n.remove());
    }
  }

  // Strip any leftover orphan MathML/HTML duplicate pairs.
  for (const dupHtml of Array.from(fragment.querySelectorAll('.katex-mathml + .katex-html'))) {
    dupHtml.remove();
  }
  for (const mathml of Array.from(fragment.querySelectorAll('.katex-mathml'))) {
    const tex = extractLatexFromKatexElement(mathml);
    if (tex) {
      mathml.replaceWith(ownerDoc.createTextNode(formatLatexForCopy(tex, false)));
    } else {
      mathml.remove();
    }
  }

  // Convert full code block wrappers to fenced Markdown code blocks.
  for (const wrapper of codeBlockWrappers) {
    if (!wrapper.isConnected && !fragment.contains(wrapper)) continue;
    const codeEl = wrapper.querySelector('pre code') ?? wrapper.querySelector('pre');
    if (!codeEl) continue;
    const rawCode = (codeEl.textContent ?? '').replace(/\n$/, '');
    const lang = wrapperLanguages.get(wrapper) ?? '';
    const fence = lang ? `\`\`\`${lang}\n${rawCode}\n\`\`\`` : `\`\`\`\n${rawCode}\n\`\`\``;
    const marker = ownerDoc.createElement('div');
    marker.setAttribute('data-copy-markdown-block', 'true');
    marker.textContent = fence;
    wrapper.replaceWith(marker);
  }

  // Convert Markdown tables (with any nested KaTeX already replaced by `$...$`) into pipe tables.
  for (const table of Array.from(fragment.querySelectorAll('table.markdown-table, .table-wrapper table'))) {
    const markdownTable = formatTableAsMarkdown(table);
    if (!markdownTable) continue;
    const target = table.closest('.table-wrapper') ?? table;
    const marker = ownerDoc.createElement('div');
    marker.setAttribute('data-copy-markdown-block', 'true');
    marker.textContent = markdownTable;
    target.replaceWith(marker);
  }

  const rawText = Array.from(fragment.childNodes)
    .map(serializeNodeToMarkdownText)
    .join('');

  const plainText = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');

  return { plainText, html };
}

/**
 * React `onCopy` handler for Markdown renderers.
 * When the user's selection includes KaTeX math, fenced code blocks, code-block
 * headers, or Markdown tables, rewrites the clipboard payload to clean raw
 * Markdown/LaTeX without KaTeX MathML/HTML duplication or UI chrome noise.
 */
export function handleMarkdownCopyEvent(event: React.ClipboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || !event.clipboardData) return;

  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0).cloneRange();

  // Expand range to enclose any partially selected KaTeX formula so its TeX
  // `<annotation>` is always present in the cloned fragment.
  const startKatex = closestKatexContainer(range.startContainer);
  if (startKatex) {
    range.setStartBefore(startKatex);
  }
  const endKatex = closestKatexContainer(range.endContainer);
  if (endKatex) {
    range.setEndAfter(endKatex);
  }

  const fragment = range.cloneContents();
  const hasRelevantMarkup =
    Boolean(startKatex) ||
    Boolean(endKatex) ||
    fragment.querySelector(COPY_RELEVANT_SELECTOR) !== null;

  if (!hasRelevantMarkup) {
    return;
  }

  const ownerDoc = event.currentTarget.ownerDocument ?? document;
  const { plainText, html } = serializeSelectionFragmentToMarkdown(fragment, ownerDoc);
  if (!plainText) return;

  event.clipboardData.setData('text/plain', plainText);
  if (html) {
    event.clipboardData.setData('text/html', html);
  }
  event.preventDefault();
}
