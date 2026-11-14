import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import contentPlugin from '../index';

const kernel = new UiKernel();
beforeAll(async () => { await kernel.install(contentPlugin, { origin: 'builtin' }); });
afterAll(async () => { await kernel.dispose(); });

const state = vi.hoisted(() => ({ tag: 'code', props: {} as Record<string, unknown> }));
vi.mock('react-markdown', () => ({ default: ({ components }: any) => React.createElement(components[state.tag], state.props) }));
vi.mock('@/features/chat/components/renderers/CodeBlock', () => ({ CodeBlock: ({ className, isStreaming, children }: any) => <pre data-codeblock data-streaming={String(isStreaming)} className={className}>{children}</pre> }));
vi.mock('@/features/chat/components/renderers/lazyKatex', () => ({ getLoadedKatex: () => ({ renderToString: (latex: string, options: any) => `<b data-display="${options.displayMode}">${latex}</b>` }), ensureKatexLoaded: vi.fn(), scheduleKatexIdlePrefetch: vi.fn() }));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));
vi.mock('@/features/chat/components/MindmapCitationCard', () => ({ MindmapCitationCard: () => null }));
vi.mock('@/features/chat/components/QbankCitationBadge', () => ({ QbankCitationBadge: () => null }));
vi.mock('@/features/chat/components/MediaCitationBadge', () => ({ MediaCitationBadge: () => null }));
vi.mock('@/features/chat/plugins/blocks/components/CitationPopover', () => ({ CitationBadgeWithPopover: () => null }));

it.each([false, true])('matches original pre/code dispatch for every golden input (provider=%s)', async (withProvider) => {
  const cases: unknown[] = [];
  for (const demo of [false, true]) for (const dark of [false, true]) for (const streaming of [false, true]) {
    (window as any).__DS_DEMO_SHELL__ = demo;
    document.documentElement.classList.toggle('dark', dark);
    for (const tag of ['pre', 'code']) for (const className of [undefined, 'language-math', 'language-latex', 'language-MATH', 'language-latex-src', 'language-mathml', 'language-mermaid', 'language-mindmap', 'language-ts', 'math math-display', 'math math-inline']) {
      for (const inline of [undefined, false, true]) for (const source of ['x + 1\n', '\\frac{a}{b}\n', 'first\nsecond\n']) {
        state.tag = tag;
        state.props = tag === 'pre' ? { children: <code className={className}>{source}</code> } : { children: source, className, inline };
        const element = <MarkdownRenderer content="fixture" isStreaming={streaming} />;
        const view = render(withProvider ? <UiKernelProvider kernel={kernel}>{element}</UiKernelProvider> : element);
        const root = view.container.querySelector('.markdown-content')!;
        cases.push({ demo, dark, streaming, tag, className: className ?? null, inline: inline ?? null, source,
          output: root.innerHTML });
        view.unmount();
      }
    }
    // Let the worker receive runner RPC replies between complete shell batches.
    await setImmediate();
  }
  cleanup();
  delete (window as any).__DS_DEMO_SHELL__;
  document.documentElement.classList.remove('dark');
  const url = 'src/ui-plugins/official/content/__golden__/markdown-dispatch.json';
  if (process.env.U4_CAPTURE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(cases, null, 2)}\n`, { flag: 'wx' });
  expect(cases).toEqual(JSON.parse(readFileSync(url, 'utf8')));
}, 60_000);

it('keeps a contributed renderer mounted while streaming values change, and revokes it on unload', async () => {
  function StatefulRenderer({ codeContent }: { codeContent: string }) {
    const [count, setCount] = React.useState(0);
    return <button onClick={() => setCount(n => n + 1)}>{codeContent}:{count}</button>;
  }
  await kernel.install(defineUiPlugin({ meta: { id: 'community.code' }, apply(ctx) {
    ctx.ui.markdown.registerCodeBlock('custom', { matches: ({ className }: any) => className === 'language-custom', component: StatefulRenderer });
  } }));
  state.tag = 'code';
  state.props = { className: 'language-custom', children: 'first' };
  const tree = (streaming: boolean) => <UiKernelProvider kernel={kernel}><MarkdownRenderer content={streaming ? 'first' : 'second'} isStreaming={streaming} /></UiKernelProvider>;
  const view = render(tree(true));
  const button = view.getByRole('button');
  fireEvent.click(button);
  state.props = { className: 'language-custom', children: 'second' };
  view.rerender(tree(false));
  expect(view.getByRole('button')).toBe(button);
  expect(button.textContent).toBe('second:1');
  await act(async () => { await kernel.unload('community.code'); });
  expect(view.queryByRole('button')).toBeNull();
  expect(view.container.textContent).toBe('second');
  view.unmount();
});

it('isolates rendering errors even when a community module replaces the official plugin id', async () => {
  const isolated = new UiKernel();
  await isolated.install(contentPlugin, { origin: 'builtin' });
  await isolated.install(defineUiPlugin({ meta: { id: 'dstu.ui.content' }, apply(ctx) {
    ctx.ui.markdown.registerCodeBlock('custom', { matches: () => true, component: () => { throw new Error('community renderer failed'); } });
  } }));
  expect(isolated.slots.get('markdown.codeBlocks', 'custom')?.origin).toBe('community');
  state.tag = 'code';
  state.props = { className: 'language-custom', children: 'original source' };
  const view = render(<UiKernelProvider kernel={isolated}><MarkdownRenderer content="fixture" /></UiKernelProvider>);
  expect(view.container.querySelector('code')?.textContent).toBe('original source');
  expect(isolated.slots.list('resource.contextMenu')).toEqual([]);
  view.unmount();
  await isolated.dispose();
});

it('uses static official entries only without a provider, not after plugin unload', async () => {
  const isolated = new UiKernel();
  await isolated.install(contentPlugin, { origin: 'builtin' });
  state.tag = 'code';
  state.props = { className: 'language-math', children: 'x + 1', inline: false };
  const plain = render(<MarkdownRenderer content="fixture" />);
  const fallbackHtml = plain.container.innerHTML;
  expect(plain.container.querySelector('b[data-display=true]')).not.toBeNull();
  plain.unmount();
  const installed = render(<UiKernelProvider kernel={isolated}><MarkdownRenderer content="fixture" /></UiKernelProvider>);
  expect(installed.container.innerHTML).toBe(fallbackHtml);
  await act(async () => { await isolated.unload(contentPlugin.meta.id); });
  expect(installed.container.querySelector('b')).toBeNull();
  expect(installed.container.querySelector('code')?.textContent).toBe('x + 1');
  installed.unmount();
  await isolated.dispose();
});
