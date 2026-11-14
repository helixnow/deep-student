import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (path: string) => path }));
vi.mock('@/features/chat/components/renderers/CodeBlock', () => ({ CodeBlock: ({ children }: any) => <pre data-codeblock>{children}</pre> }));
vi.mock('@/features/chat/components/renderers/lazyKatex', () => ({ getLoadedKatex: () => null, ensureKatexLoaded: vi.fn(), scheduleKatexIdlePrefetch: vi.fn() }));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));

import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import { officialRehypeEntries, officialRemarkEntries } from '@/features/chat/components/renderers/markdownPipeline';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '../install';
import { memoryRegistryAdapters } from '../../testing/registries';

let kernel: UiKernel | undefined;
afterEach(async () => {
  await kernel?.dispose();
  kernel = undefined;
});

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  return kernel;
}

const describeEntries = (entries: readonly { id: string; order: number; owner: string; origin: string }[]) =>
  entries.map(({ id, order, owner, origin }) => ({ id, order, owner, origin }));

function renderMarkdown(k: UiKernel, content: string) {
  const view = render(<UiKernelProvider kernel={k}><MarkdownRenderer content={content} /></UiKernelProvider>);
  const html = view.container.innerHTML;
  view.unmount();
  return html;
}

function replaceText(from: RegExp, to: string) {
  return () => (tree: any) => {
    const walk = (node: any) => {
      if (node.type === 'text') node.value = String(node.value).replace(from, to);
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

describe('markdown.remark / markdown.rehype (FE-B6)', () => {
  it('holds the official steps in pipeline order, owned by dstu.ui.content', async () => {
    const k = await boot();
    expect(describeEntries(k.slots.list('markdown.remark'))).toEqual(describeEntries(officialRemarkEntries));
    expect(describeEntries(k.slots.list('markdown.rehype'))).toEqual(describeEntries(officialRehypeEntries));
    expect(k.slots.list('markdown.remark').map((entry) => entry.value)).toEqual(officialRemarkEntries.map((entry) => entry.value));
  });

  it('runs community steps at their order; rehype steps below 20 are sanitized', async () => {
    const k = await boot();
    const before = renderMarkdown(k, 'hello world');
    await k.install(defineUiPlugin({ meta: { id: 'community.md' }, apply(ctx) {
      ctx.ui.contribute('markdown.remark', { id: 'shout', order: 65, value: { create: () => replaceText(/world/g, 'WORLD') } });
      ctx.ui.contribute('markdown.rehype', { id: 'inject', order: 15, value: { create: () => () => (tree: any) => {
        tree.children.push({ type: 'element', tagName: 'script', properties: {}, children: [{ type: 'text', value: 'x' }] });
        tree.children.push({ type: 'element', tagName: 'em', properties: { className: ['injected'] }, children: [{ type: 'text', value: 'kept' }] });
      } } });
    } }));
    const after = renderMarkdown(k, 'hello world');
    expect(after).toContain('hello WORLD');
    expect(after).not.toContain('<script');
    expect(after).toContain('<em>kept</em>');
    await k.unload('community.md');
    expect(renderMarkdown(k, 'hello world')).toBe(before);
  });

  it('skips a throwing community step, reports it to the error budget and unloads the plugin when exhausted', async () => {
    const k = await boot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const expected = renderMarkdown(k, '**bold** text');
    await k.install(defineUiPlugin({ meta: { id: 'community.broken' }, apply(ctx) {
      ctx.ui.contribute('markdown.remark', { id: 'broken', order: 5, value: { create: () => () => () => { throw new Error('broken remark step'); } } });
    } }));
    expect(renderMarkdown(k, '**bold** text')).toBe(expected);
    expect(k.errors.list('community.broken')[0]).toMatchObject({ slot: 'markdown.remark', entryId: 'broken', phase: 'render' });
    renderMarkdown(k, 'again');
    renderMarkdown(k, 'and again');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(k.list()).not.toContain('community.broken');
    error.mockRestore();
  });

  it('removes the official pipeline with its plugin', async () => {
    const k = await boot();
    await k.unload('dstu.ui.content');
    expect(k.slots.list('markdown.remark')).toEqual([]);
    expect(k.slots.list('markdown.rehype')).toEqual([]);
  });
});

describe('genui.components (FE-B6)', () => {
  const intent = (type: string, props: Record<string, unknown>) => ({ version: '1', blocks: [{ type, props }] });

  it('renders a community block through the slot and loses built-ins when dstu.ui.genui unloads', async () => {
    const k = await boot();
    expect(k.slots.list('genui.components').map((entry) => entry.key)).toEqual(
      ['action-bar', 'alert', 'chart', 'flashcard-preview', 'key-value-grid', 'list', 'markdown', 'mindmap-embed', 'mistake-analysis',
        'paper-digest', 'progress', 'research-plan', 'research-report', 'review-calendar', 'stat-card', 'steps', 'table', 'text'],
    );
    const { z } = await import('zod');
    await k.install(defineUiPlugin({ meta: { id: 'community.badge' }, apply(ctx) {
      ctx.ui.contribute('genui.components', { id: 'badge', key: 'badge', value: {
        type: 'badge', propsSchema: z.object({ label: z.string() }), component: ({ label }: { label: string }) => <b data-badge>{label}</b>,
      } });
    } }));
    const show = (value: unknown) => {
      const view = render(<UiKernelProvider kernel={k}><GenerativeUIRenderer intent={value as never} showChrome={false} /></UiKernelProvider>);
      const html = view.container.innerHTML;
      view.unmount();
      return html;
    };
    expect(show(intent('badge', { label: 'community' }))).toContain('<b data-badge="true">community</b>');
    expect(show(intent('text', { body: 'built-in' }))).toContain('built-in');
    await k.unload('dstu.ui.genui');
    expect(show(intent('text', { body: 'built-in' }))).toContain('data-block-error-codes="unknown-type"');
  });
});
