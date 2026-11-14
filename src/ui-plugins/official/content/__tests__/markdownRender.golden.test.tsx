/**
 * FE-B6 evidence: real react-markdown + remark/rehype output of MarkdownRenderer for fixtures that exercise every
 * plugin in the pipeline (indented code, full-width punctuation, math code blocks, remark-math, inline SMILES, GFM,
 * citations, raw HTML + sanitize, search highlights, extra remark plugins), with and without the UI kernel.
 * Only leaf renderers that are not part of the pipeline are stubbed. Captured before FE-B6; never rewritten.
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('@/features/chat/components/renderers/CodeBlock', () => ({ CodeBlock: ({ className, children }: any) => <pre data-codeblock className={className}>{children}</pre> }));
vi.mock('@/features/chat/components/renderers/lazyKatex', () => ({ getLoadedKatex: () => ({ renderToString: (latex: string, options: any) => `<b data-display="${options.displayMode}">${latex}</b>` }), ensureKatexLoaded: vi.fn(), scheduleKatexIdlePrefetch: vi.fn() }));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));
vi.mock('@/features/chat/components/renderers/InlineSmiles', () => ({ InlineSmiles: ({ smiles }: any) => <i data-inline-smiles={smiles} /> }));
vi.mock('@/features/chat/components/MindmapCitationCard', () => ({ MindmapCitationCard: () => <i data-mindmap-card /> }));
vi.mock('@/features/chat/components/QbankCitationBadge', () => ({ QbankCitationBadge: () => <i data-qbank-badge /> }));
vi.mock('@/features/chat/components/MediaCitationBadge', () => ({ MediaCitationBadge: () => <i data-media-badge /> }));
vi.mock('@/features/chat/plugins/blocks/components/CitationPopover', () => ({ CitationBadgeWithPopover: ({ citationType, citationIndex }: any) => <i data-citation-badge={`${citationType}:${citationIndex}`} /> }));

import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import { MessageSearchProvider } from '@/features/chat/components/messageSearchContext';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import contentPlugin from '../index';

const GOLDEN = 'src/ui-plugins/official/content/__golden__/markdown-render.json';

const kernel = new UiKernel();
beforeAll(async () => { await kernel.install(contentPlugin, { origin: 'builtin' }); });
afterAll(async () => { await kernel.dispose(); });

const FIXTURES: Record<string, string> = {
  basic: '# Title\n\nParagraph with **bold**, _em_, `code` and a [link](https://example.com).\n\n> quote',
  indented: 'Text\n\n    indented line stays a paragraph\n\nAfter',
  fullWidth: '＊强调＊ 与 ＃标题 ～删除～ ＿下划线＿',
  mathInline: 'Euler $e^{i\\pi}+1=0$ and \\(a^2+b^2\\) inline.',
  mathBlock: '$$\n\\int_0^1 x\\,dx\n$$\n\n\\[ x^2 \\]',
  mathCodeBlocks: '```math\n\\frac{a}{b}\n```\n\n```latex\nx+y\n```\n\n```ts\nconst a = 1;\n```',
  gfm: '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~strike~~ https://auto.example.com',
  smiles: 'Benzene \\smiles{c1ccccc1} ring and `\\smiles{CC}` in code.',
  rawHtml: '<div onclick="x()" style="color:red"><span class="ok" data-citation="true" title="t">safe</span><script>alert(1)</script><a href="javascript:alert(1)">bad</a></div>',
  citations: '根据资料[知识库-1]和[图片-2]，以及[记忆-3]、[题目集:exam_1#q2:期中]。',
  search: 'Needle in a haystack: needle, NEEDLE and needles.\n\n```\nneedle in code\n```',
};

function shout() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (node.type === 'text') node.value = String(node.value).replace(/haystack/g, 'HAYSTACK');
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
const EXTRA = [shout];

it('renders every fixture identically through the real pipeline', () => {
  const cases: unknown[] = [];
  for (const provider of [false, true]) for (const [fixture, content] of Object.entries(FIXTURES))
    for (const citations of [false, true]) for (const query of ['', 'needle']) for (const extra of [false, true]) {
      const element = (
        <MessageSearchProvider query={query}>
          <MarkdownRenderer content={content} enableCitations={citations} extraRemarkPlugins={extra ? EXTRA : undefined} />
        </MessageSearchProvider>
      );
      const view = render(provider ? <UiKernelProvider kernel={kernel}>{element}</UiKernelProvider> : element);
      cases.push({ provider, fixture, citations, query, extra, html: view.container.innerHTML });
      view.unmount();
    }
  cleanup();
  if (process.env.FE_B6_CAPTURE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(cases, null, 2)}\n`, { flag: 'wx' });
  expect(cases).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
}, 60_000);
