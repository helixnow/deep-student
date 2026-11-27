import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import katex from 'katex';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(async () => true),
  mermaidInitialize: vi.fn(),
  mermaidRender: vi.fn(async (_id: string, code: string) => ({
    svg: `<svg aria-roledescription="flowchart-v2" viewBox="0 0 240 120"><g class="edgePath"><path class="flowchart-link" d="M0,0 L100,0" /></g><g class="node"><rect width="80" height="40" /><text class="nodeLabel">${code.slice(0, 24)}</text></g></svg>`,
  })),
}));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/lazyStyles', () => ({
  ensureKatexStyles: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: mocks.mermaidInitialize,
    render: mocks.mermaidRender,
  },
}));

vi.mock('@/utils/lazyPrism', () => ({
  resolvePrismLanguage: () => null,
  getLoadedPrismGrammar: () => null,
  loadPrismLanguage: vi.fn(async () => null),
}));

vi.mock('../lazyKatex', () => ({
  getLoadedKatex: () => katex,
  ensureKatexLoaded: vi.fn(async () => katex),
  scheduleKatexIdlePrefetch: vi.fn(),
}));

import { MarkdownRenderer } from '../MarkdownRenderer';
import { StreamingBlockRenderer } from '../StreamingBlockRenderer';
import { CodeBlock, getMermaidThemeConfig, isDocumentDarkMode } from '../CodeBlock';
import {
  extractTextFromReactNode,
  serializeSelectionFragmentToMarkdown,
} from '../markdownCopyFidelity';

function makeWideTenColumnTable(): string {
  const headers = Array.from({ length: 10 }, (_, i) => `Column_${i + 1}`);
  const separator = headers.map(() => '---');
  const row1 = headers.map((_, i) => `Value_${i + 1}_LongContent`);
  const row2 = headers.map((_, i) => (i === 0 ? '$E = mc^2$' : `Row2_${i + 1}`));
  return [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    `| ${row1.join(' | ')} |`,
    `| ${row2.join(' | ')} |`,
  ].join('\n');
}

function makeSixtyLineWideCode(): string {
  return Array.from(
    { length: 60 },
    (_, i) =>
      `export const line_${String(i + 1).padStart(2, '0')} = "extremely_wide_payload_segment_${i + 1}_".repeat(4);`,
  ).join('\n');
}

function dispatchCopyWithSelection(target: Element, range: Range) {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  const written: Record<string, string> = {};
  const clipboardData = {
    setData: vi.fn((type: string, data: string) => {
      written[type] = data;
    }),
    getData: (type: string) => written[type] ?? '',
  };

  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: clipboardData,
  });

  target.dispatchEvent(event);
  return { event, written, setData: clipboardData.setData };
}

async function clickMermaidRunAndSettle(runButton: HTMLButtonElement) {
  await act(async () => {
    runButton.click();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      } else {
        setTimeout(resolve, 0);
      }
    });
    await Promise.resolve();
  });
}

describe('U04 Heavy Mixed Rich Content — Containment, Dark-Mode Readability & Copy-Paste Fidelity', () => {
  beforeEach(() => {
    mocks.copyTextToClipboard.mockClear();
    mocks.mermaidInitialize.mockClear();
    mocks.mermaidRender.mockClear();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.remove('dark');
    window.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.remove('dark');
    window.getSelection()?.removeAllRanges();
  });

  describe('1. Wide Table, Long Code Block & Multi-Line KaTeX Containment', () => {
    it('wraps 10-column tables, 60-line wide code blocks, and multi-line KaTeX matrices in horizontal scroll containers', () => {
      const heavyMarkdown = [
        '## Mixed Heavy Content',
        '',
        makeWideTenColumnTable(),
        '',
        'Inline tall fraction $\\frac{a^{2^n} + b^{2^n}}{c_{i_k} + d_{j_m}}$ inside prose.',
        '',
        '$$',
        'A = \\begin{bmatrix} a_{11} & a_{12} & a_{13} & a_{14} \\\\ a_{21} & a_{22} & a_{23} & a_{24} \\\\ a_{31} & a_{32} & a_{33} & a_{34} \\end{bmatrix}',
        '$$',
        '',
        '```ts',
        makeSixtyLineWideCode(),
        '```',
      ].join('\n');

      const { container } = render(
        <div className="chat-v2" style={{ width: '460px' }}>
          <StreamingBlockRenderer content={heavyMarkdown} isStreaming={false} />
        </div>,
      );

      // 10-column table wrapped inside horizontal ScrollArea
      const tableWrapper = container.querySelector('.table-wrapper');
      const tableScrollArea = tableWrapper?.querySelector('.table-scroll-area');
      const table = tableScrollArea?.querySelector('table.markdown-table');
      expect(tableWrapper).not.toBeNull();
      expect(tableScrollArea).not.toBeNull();
      expect(tableScrollArea?.getAttribute('data-orientation')).toBe('horizontal');
      expect(tableScrollArea?.className).toContain('min-w-0');
      expect(table?.querySelectorAll('thead th')).toHaveLength(10);

      // Multi-line KaTeX matrix wrapped inside horizontal math ScrollArea
      const mathScrollArea = container.querySelector('.math-scroll-area');
      expect(mathScrollArea).not.toBeNull();
      expect(mathScrollArea?.getAttribute('data-orientation')).toBe('horizontal');
      expect(mathScrollArea?.className).toContain('min-w-0');
      expect(mathScrollArea?.querySelector('.katex-display')).not.toBeNull();

      // Inline tall fraction wrapped inside .math-inline-scroll
      const inlineMathScroll = container.querySelector('.math-inline-scroll');
      expect(inlineMathScroll).not.toBeNull();
      expect(inlineMathScroll?.querySelector('.katex')).not.toBeNull();

      // 60-line wide code block wrapped inside bidirectional scroll area with containment classes
      const codeScrollArea = container.querySelector('.code-block-scroll-area');
      expect(codeScrollArea).not.toBeNull();
      expect(codeScrollArea?.className).toContain('max-w-full');
      expect(codeScrollArea?.className).toContain('overflow-x-auto');
      expect(codeScrollArea?.className).toContain('min-w-0');
      expect(codeScrollArea?.querySelector('pre code')?.textContent).toContain('line_60');
    });

    it('declares CSS overflow containment and KaTeX vertical padding across chat stylesheets', () => {
      const markdownCss = fs.readFileSync(
        path.resolve(__dirname, '../../../styles/markdown.css'),
        'utf-8',
      );
      const streamingBlocksCss = fs.readFileSync(
        path.resolve(__dirname, '../streamingBlocks.css'),
        'utf-8',
      );
      const beautifyCss = fs.readFileSync(
        path.resolve(__dirname, '../../../styles/chat-beautify.css'),
        'utf-8',
      );

      // Table horizontal scroll container prevents bubble blowout
      const tableScrollRule = markdownCss.slice(
        markdownCss.indexOf('.chat-v2 .markdown-content .table-scroll-area.scroll-area--native {'),
        markdownCss.indexOf('}', markdownCss.indexOf('.chat-v2 .markdown-content .table-scroll-area.scroll-area--native {')) + 1,
      );
      expect(tableScrollRule).toContain('max-width: 100%;');
      expect(tableScrollRule).toContain('min-width: 0;');
      expect(tableScrollRule).toContain('overflow-x: auto;');

      // Display KaTeX container + standalone .katex-display containment & vertical breathing room
      const mathScrollRule = markdownCss.slice(
        markdownCss.indexOf('.chat-v2 .markdown-content .math-scroll-area.scroll-area--native {'),
        markdownCss.indexOf('}', markdownCss.indexOf('.chat-v2 .markdown-content .math-scroll-area.scroll-area--native {')) + 1,
      );
      expect(mathScrollRule).toContain('max-width: 100%;');
      expect(mathScrollRule).toContain('min-width: 0;');
      expect(mathScrollRule).toContain('overflow-x: auto;');
      expect(mathScrollRule).toContain('padding-top:');
      expect(mathScrollRule).toContain('padding-bottom:');

      const katexDisplayRule = markdownCss.slice(
        markdownCss.indexOf('.chat-v2 .markdown-content .katex-display {'),
        markdownCss.indexOf('}', markdownCss.indexOf('.chat-v2 .markdown-content .katex-display {')) + 1,
      );
      expect(katexDisplayRule).toContain('max-width: 100%;');
      expect(katexDisplayRule).toContain('overflow-x: auto;');
      expect(katexDisplayRule).toContain('padding-top:');
      expect(katexDisplayRule).toContain('padding-bottom:');

      // Streaming blocks and user bubbles prevent flex min-content blowout
      expect(streamingBlocksCss).toContain('min-width: 0;');
      expect(streamingBlocksCss).toContain('max-width: 100%;');
      expect(beautifyCss).toContain('.chat-v2 .user-message-bubble {');
      expect(beautifyCss).toContain('min-width: 0;');
    });
  });

  describe('2. Dark-Mode Readability for Mermaid SVGs, Inline Diagrams & Tables', () => {
    it('selects high-contrast dark Mermaid theme variables in dark mode and light neutral variables in light mode', () => {
      expect(isDocumentDarkMode()).toBe(false);
      document.documentElement.classList.add('dark');
      expect(isDocumentDarkMode()).toBe(true);
      document.documentElement.classList.remove('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
      expect(isDocumentDarkMode()).toBe(true);

      const darkConfig = getMermaidThemeConfig(true);
      expect(darkConfig.theme).toBe('dark');
      expect(darkConfig.themeVariables.darkMode).toBe(true);
      // Light text, edges, arrows, and sequence signals against dark surfaces (never dark/black)
      expect(darkConfig.themeVariables.primaryTextColor).toMatch(/^#[ef]/i);
      expect(darkConfig.themeVariables.textColor).toMatch(/^#[ef]/i);
      expect(darkConfig.themeVariables.nodeTextColor).toMatch(/^#[ef]/i);
      expect(darkConfig.themeVariables.lineColor).toMatch(/^#[cdef]/i);
      expect(darkConfig.themeVariables.signalColor).toMatch(/^#[cdef]/i);
      expect(darkConfig.themeVariables.signalTextColor).toMatch(/^#[ef]/i);
      expect(darkConfig.themeVariables.actorTextColor).toMatch(/^#[ef]/i);
      expect(darkConfig.themeVariables.edgeLabelBackground).toMatch(/^#[12]/i);

      const lightConfig = getMermaidThemeConfig(false);
      expect(lightConfig.theme).toBe('neutral');
      expect(lightConfig.themeVariables.darkMode).toBe(false);
      expect(lightConfig.themeVariables.textColor).toMatch(/^#[012]/i);
    });

    it('initializes Mermaid with dark theme variables in Dark Mode and live-rerenders when theme toggles', async () => {
      document.documentElement.classList.add('dark');
      const flowchartCode = 'flowchart TD\n  A[Start] --> B[End]';

      const { container } = render(
        <CodeBlock className="language-mermaid">{flowchartCode}</CodeBlock>,
      );

      const runBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('运行') && !btn.textContent?.includes('运行中'),
      ) as HTMLButtonElement;
      expect(runBtn).toBeDefined();

      await clickMermaidRunAndSettle(runBtn);

      expect(mocks.mermaidInitialize).toHaveBeenCalledTimes(1);
      const darkInitArg = mocks.mermaidInitialize.mock.calls[0][0];
      expect(darkInitArg.theme).toBe('dark');
      expect(darkInitArg.themeVariables.darkMode).toBe(true);
      expect(darkInitArg.themeVariables.primaryTextColor).toBe('#f3f4f6');
      expect(darkInitArg.themeVariables.lineColor).toBe('#cbd5e1');
      expect(container.querySelector('.mermaid-content')?.getAttribute('data-mermaid-diagram')).toBe('true');

      // Flipping from dark to light live-rerenders Mermaid with light neutral theme
      await act(async () => {
        document.documentElement.classList.remove('dark');
        await Promise.resolve();
      });

      await waitFor(() => expect(mocks.mermaidInitialize).toHaveBeenCalledTimes(2));
      const lightInitArg = mocks.mermaidInitialize.mock.calls[1][0];
      expect(lightInitArg.theme).toBe('neutral');
      expect(lightInitArg.themeVariables.darkMode).toBe(false);
    });

    it('provides dark-mode CSS contrast rules for Mermaid SVGs, inline diagrams, and Markdown table headers/stripes/borders', () => {
      const markdownCss = fs.readFileSync(
        path.resolve(__dirname, '../../../styles/markdown.css'),
        'utf-8',
      );

      // Mermaid dark-mode contrast safety net
      expect(markdownCss).toContain(".dark .chat-v2 .mermaid-content[data-mermaid-diagram='true'] svg text");
      expect(markdownCss).toContain(".dark .chat-v2 .mermaid-content[data-mermaid-diagram='true'] svg .flowchart-link");
      expect(markdownCss).toContain(".dark .chat-v2 .mermaid-content[data-mermaid-diagram='true'] svg .messageLine0");
      expect(markdownCss).toContain(".dark .chat-v2 .mermaid-content[data-mermaid-diagram='true'] svg marker path");

      // Table headers, alternating row stripes, and dark-mode contrast borders
      expect(markdownCss).toContain('.chat-v2 .markdown-table thead {');
      expect(markdownCss).toContain('.chat-v2 .markdown-table tbody tr:nth-child(even) {');
      expect(markdownCss).toContain('.dark .chat-v2 .markdown-table thead,');
      expect(markdownCss).toContain('.dark .chat-v2 .markdown-table tbody tr:nth-child(even),');
      expect(markdownCss).toContain('border-top-color: hsl(var(--foreground) / 28%);');

      // Dark-mode inline diagrams (dot / abc / wavedrom / molecule-2d)
      expect(markdownCss).toContain('.dark .chat-v2 .markdown-content .rich-code-renderer--dot svg');
    });
  });

  describe('3. Copy-Paste Fidelity (Markdown / LaTeX / Code)', () => {
    it('copies clean raw LaTeX ($...$ and $$...$$) without KaTeX duplicate MathML/HTML noise', () => {
      const content = [
        'Einstein showed $E = mc^2$ in 1905.',
        '',
        '$$',
        '\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}',
        '$$',
      ].join('\n');

      const { container } = render(<MarkdownRenderer content={content} />);
      const root = container.querySelector('.markdown-content')!;

      // Sanity check: rendered DOM contains both MathML and visual HTML layers
      expect(root.querySelectorAll('.katex-mathml').length).toBeGreaterThanOrEqual(2);
      expect(root.querySelectorAll('.katex-html').length).toBeGreaterThanOrEqual(2);

      const range = document.createRange();
      range.selectNodeContents(root);
      const { event, written } = dispatchCopyWithSelection(root, range);

      expect(event.defaultPrevented).toBe(true);
      expect(written['text/plain']).toContain('Einstein showed $E = mc^2$ in 1905.');
      expect(written['text/plain']).toContain('$$\\begin{bmatrix}1&2 \\\\ 3&4\\end{bmatrix}$$');
      // Must NOT duplicate the rendered KaTeX output
      expect(written['text/plain'].match(/E\s*=\s*mc\^2/g)).toHaveLength(1);
      expect(written['text/plain']).not.toContain('E=mc2');
    });

    it('expands a partial selection inside a KaTeX formula to copy clean full LaTeX', () => {
      const { container } = render(<MarkdownRenderer content={'Formula $\\frac{a}{b}$ end.'} />);
      const root = container.querySelector('.markdown-content')!;
      const katexHtml = root.querySelector('.katex-html')!;
      expect(katexHtml).not.toBeNull();

      const range = document.createRange();
      range.selectNodeContents(katexHtml);
      const { event, written } = dispatchCopyWithSelection(katexHtml, range);

      expect(event.defaultPrevented).toBe(true);
      expect(written['text/plain']).toBe('$\\frac{a}{b}$');
    });

    it('copies multi-block AI responses (prose + KaTeX + table + fenced code block) cleanly without code header chrome', () => {
      const content = [
        'Summary with $\\alpha + \\beta$.',
        '',
        '| Name | Formula |',
        '| --- | --- |',
        '| Area | $A = \\pi r^2$ |',
        '',
        '```python',
        'def solve(x):',
        '    return x * 2',
        '```',
      ].join('\n');

      const { container } = render(
        <StreamingBlockRenderer content={content} isStreaming={false} />,
      );
      const root = container.querySelector('.streaming-block-renderer')!;

      const range = document.createRange();
      range.selectNodeContents(root);
      const { event, written } = dispatchCopyWithSelection(root, range);

      expect(event.defaultPrevented).toBe(true);
      const copied = written['text/plain'];
      expect(copied).toContain('Summary with $\\alpha + \\beta$.');
      expect(copied).toContain('| Name | Formula |');
      expect(copied).toContain('| Area | $A = \\pi r^2$ |');
      expect(copied).toContain('```python\ndef solve(x):\n    return x * 2\n```');
      // Must NOT leak code block header chrome buttons or duplicate KaTeX HTML
      expect(copied).not.toContain('复制');
      expect(copied).not.toContain('Copy');
      expect(copied).not.toContain('▶');
    });

    it('leaves plain prose copy unhandled so native browser selection copy works unchanged', () => {
      const { container } = render(<MarkdownRenderer content="Plain text without math or code." />);
      const paragraph = container.querySelector('p')!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const { event, setData } = dispatchCopyWithSelection(paragraph, range);

      expect(event.defaultPrevented).toBe(false);
      expect(setData).not.toHaveBeenCalled();
    });

    it('copies clean raw code from CodeBlock even when children contain search highlight <mark> elements', async () => {
      const highlightedChildren = [
        'const ',
        <mark key="m1" className="chat-search-match">answer</mark>,
        ' = 42;\n',
      ];
      expect(extractTextFromReactNode(highlightedChildren)).toBe('const answer = 42;\n');

      const { container } = render(
        <CodeBlock className="language-ts">{highlightedChildren}</CodeBlock>,
      );

      const copyButton = Array.from(container.querySelectorAll('.code-block-header button')).find((btn) =>
        /复制|Copy/i.test(btn.textContent ?? ''),
      ) as HTMLButtonElement;
      expect(copyButton).toBeDefined();

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(mocks.copyTextToClipboard).toHaveBeenCalledWith('const answer = 42;');
      expect(mocks.copyTextToClipboard.mock.calls[0][0]).not.toContain('[object Object]');
    });

    it('formats multiline display matrices with block $$ fences cleanly in serializer', () => {
      const alignedTex = '\\begin{aligned}\na &= b + c \\\\\nd &= e + f\n\\end{aligned}';
      const div = document.createElement('div');
      div.innerHTML = katex.renderToString(alignedTex, {
        displayMode: true,
        throwOnError: false,
      });
      const frag = document.createDocumentFragment();
      while (div.firstChild) frag.appendChild(div.firstChild);

      const { plainText } = serializeSelectionFragmentToMarkdown(frag);
      expect(plainText).toBe(`$$\n${alignedTex}\n$$`);
    });
  });
});
