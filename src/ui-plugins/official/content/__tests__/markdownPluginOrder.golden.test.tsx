/**
 * FE-B6 evidence: the remark/rehype plugin lists MarkdownRenderer hands to react-markdown, in order, with options,
 * for every input that changes them (citations, search query, extra remark plugins, streaming) with and without the
 * UI kernel. Also records whether the lists keep their identity across a re-render with unchanged inputs (react-markdown
 * re-parses when they change). Captured before FE-B6; the golden is never rewritten.
 */
import React from 'react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ props: [] as Array<{ remarkPlugins: unknown[]; rehypePlugins: unknown[] }> }));

vi.mock('react-markdown', () => ({
  default: (props: { remarkPlugins: unknown[]; rehypePlugins: unknown[] }) => {
    captured.props.push({ remarkPlugins: props.remarkPlugins, rehypePlugins: props.rehypePlugins });
    return null;
  },
}));
vi.mock('@/features/chat/components/renderers/CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('@/features/chat/components/renderers/lazyKatex', () => ({ getLoadedKatex: () => null, ensureKatexLoaded: vi.fn(), scheduleKatexIdlePrefetch: vi.fn() }));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));

import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import { MessageSearchProvider } from '@/features/chat/components/messageSearchContext';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import contentPlugin from '../index';

const GOLDEN = 'src/ui-plugins/official/content/__golden__/markdown-plugin-order.json';

const kernel = new UiKernel();
beforeAll(async () => { await kernel.install(contentPlugin, { origin: 'builtin' }); });
afterAll(async () => { await kernel.dispose(); });

function customRemarkPlugin() {
  return () => {};
}
const EXTRA = [customRemarkPlugin];

const name = (plugin: unknown) => (typeof plugin === 'function' ? plugin.name || 'anonymous' : typeof plugin);

function describeOptions(options: unknown): unknown {
  if (!options || typeof options !== 'object') return options ?? null;
  const json = JSON.stringify(options);
  return json.length > 200 ? { keys: Object.keys(options).sort(), sha256: createHash('sha256').update(json).digest('hex') } : options;
}

function describePlugins(list: unknown[]) {
  return list.map((entry) => (Array.isArray(entry)
    ? { plugin: name(entry[0]), options: describeOptions(entry[1]) }
    : { plugin: name(entry) }));
}

it('records the plugin order for every input combination (provider and lightweight window)', () => {
  const cases: unknown[] = [];
  for (const provider of [false, true]) for (const citations of ['default', 'enabled', 'disabled', 'implied'] as const)
    for (const query of ['', '   ', 'needle']) for (const extra of [false, true]) for (const isStreaming of [false, true]) {
      const props = {
        content: 'fixture',
        isStreaming,
        ...(citations === 'enabled' ? { enableCitations: true } : citations === 'disabled' ? { enableCitations: false, onCitationClick: () => {} } : citations === 'implied' ? { onCitationClick: () => {} } : {}),
        ...(extra ? { extraRemarkPlugins: EXTRA } : {}),
      };
      const tree = (p: typeof props) => {
        const body = <MessageSearchProvider query={query}><MarkdownRenderer {...p} /></MessageSearchProvider>;
        return provider ? <UiKernelProvider kernel={kernel}>{body}</UiKernelProvider> : body;
      };
      captured.props = [];
      const view = render(tree(props));
      view.rerender(tree({ ...props }));
      const [first, second] = [captured.props[0], captured.props.at(-1)!];
      cases.push({
        provider, citations, query, extra, isStreaming,
        remark: describePlugins(first.remarkPlugins),
        rehype: describePlugins(first.rehypePlugins),
        stableAcrossRerender: { remark: first.remarkPlugins === second.remarkPlugins, rehype: first.rehypePlugins === second.rehypePlugins },
      });
      view.unmount();
    }
  cleanup();
  if (process.env.FE_B6_CAPTURE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(cases, null, 2)}\n`, { flag: 'wx' });
  expect(cases).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
});
