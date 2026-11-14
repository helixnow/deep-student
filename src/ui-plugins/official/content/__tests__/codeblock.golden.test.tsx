import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CodeBlock } from '@/features/chat/components/renderers/CodeBlock';
import { DEFAULT_RENDERER_CAPABILITIES, type RendererCapabilities } from '@/features/chat/components/renderers/rendererCapabilities';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import contentPlugin from '../index';

const runtime = vi.hoisted(() => ({ mermaidLoads: 0, touch: false }));
vi.mock('mermaid', () => {
  runtime.mermaidLoads++;
  return { default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 100 50"><text>mindmap diagram</text></svg>' })) } };
});
vi.mock('@/features/chat/components/renderers/RichCodeRenderer', () => ({ RichCodeRenderer: ({ kind, source }: any) => <div data-rich-kind={kind}>{source}</div> }));
vi.mock('@/components/previews/ChatHtmlPreview', () => ({ ChatHtmlPreview: ({ html, streaming, expanded }: any) => <div data-html-preview data-streaming={String(streaming)} data-expanded={String(expanded)}>{html}</div> }));
vi.mock('react-syntax-highlighter/dist/esm/prism', () => ({ default: ({ children }: any) => <span>{children}</span> }));

const languages = ['mermaid', 'MERMAID', 'svg', 'html', 'htm', 'xml', 'vega-lite', 'vega', 'dot', 'abc', 'wavedrom', 'mol', 'molfile', 'sdf', 'pdb', 'geojson', 'mindmap', 'text', 'ts'];
const capsOff = Object.fromEntries(Object.keys(DEFAULT_RENDERER_CAPABILITIES).map(key => [key, false])) as unknown as RendererCapabilities;
const capsOn = Object.fromEntries(Object.keys(capsOff).map(key => [key, true])) as unknown as RendererCapabilities;
const sourceFor = (language: string) => {
  switch (language.toLowerCase()) {
    case 'svg': return '<svg viewBox="0 0 100 50"><text>diagram</text></svg>';
    case 'html': case 'htm': return '<!doctype html><html><head><style>p{color:red}</style></head><body><p>example</p></body></html>';
    case 'xml': return '<items><item>example</item></items>';
    case 'mermaid': return 'mindmap\n  root((Example))\n    Child';
    default: return 'example source';
  }
};

function summary(container: HTMLElement) {
  const header = container.querySelector('.code-block-header');
  return {
    language: container.querySelector('.code-block-lang')?.textContent ?? null,
    buttons: Array.from(header?.querySelectorAll('button') ?? []).map(button => ({
      text: button.textContent, title: button.title, ariaLabel: button.getAttribute('aria-label'), disabled: button.disabled,
    })),
    source: container.querySelector('pre code')?.textContent ?? null,
    richKind: container.querySelector('[data-rich-kind]')?.getAttribute('data-rich-kind') ?? null,
    html: container.querySelector('[data-html-preview]')?.textContent ?? null,
    svg: container.querySelector('.mermaid-content')?.textContent ?? null,
    previewKind: container.querySelector('[data-preview-kind]')?.getAttribute('data-preview-kind') ?? null,
  };
}

it.each([false, true])('retains original CodeBlock dispatch and run timing (provider=%s)', async (withProvider) => {
  const kernel = new UiKernel();
  if (withProvider) await kernel.install(contentPlugin, { origin: 'builtin' });
  const renderBlock = (element: React.ReactElement) => render(withProvider ? <UiKernelProvider kernel={kernel}>{element}</UiKernelProvider> : element);
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: runtime.touch && query === '(pointer: coarse)', media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, onchange: null })) as typeof window.matchMedia;
  const cases: unknown[] = [];
  try {
    for (const mode of ['off', 'on', ...Object.keys(capsOff)] as const) {
      const capabilities = mode === 'off' ? capsOff : mode === 'on' ? capsOn : { ...capsOff, [mode]: true };
      for (const language of languages) for (const streaming of [false, true]) {
        const view = renderBlock(<CodeBlock className={`language-${language}`} isStreaming={streaming} rendererCapabilities={capabilities}>{sourceFor(language)}</CodeBlock>);
        await act(async () => { await Promise.resolve(); });
        const before = summary(view.container);
        const run = Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('▶'));
        const canRun = !!run && !run.disabled;
        if (canRun) await act(async () => { run.click(); await Promise.resolve(); });
        cases.push({ mode, language, streaming, before, ran: canRun, after: summary(view.container) });
        view.unmount();
      }
      // React act flushes microtasks; runner RPC replies also need an event-loop turn.
      await setImmediate();
    }
    // No platform/theme/demo condition exists in the old dispatch. Exercise the
    // same manual Mermaid/mindmap path under each supported shell input as well.
    for (const touch of [false, true]) for (const dark of [false, true]) for (const demo of [false, true]) {
      runtime.touch = touch;
      document.documentElement.classList.toggle('dark', dark);
      (window as any).__DS_DEMO_SHELL__ = demo;
      const view = renderBlock(<CodeBlock className="language-mermaid" rendererCapabilities={capsOn}>{sourceFor('mermaid')}</CodeBlock>);
      const before = summary(view.container);
      const run = Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('▶'))!;
      await act(async () => { run.click(); await Promise.resolve(); });
      cases.push({ touch, dark, demo, before, after: summary(view.container) });
      view.unmount();
    }
  } finally {
    await kernel.dispose();
    window.matchMedia = originalMatchMedia;
    runtime.touch = false;
    document.documentElement.classList.remove('dark');
    delete (window as any).__DS_DEMO_SHELL__;
  }
  const file = 'src/ui-plugins/official/content/__golden__/codeblock-dispatch.json';
  if (process.env.U4_CAPTURE_CODEBLOCK === '1') writeFileSync(file, `${JSON.stringify(cases, null, 2)}\n`, { flag: 'wx' });
  expect(cases).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  expect(runtime.mermaidLoads).toBe(1);
}, 60_000);
