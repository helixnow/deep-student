/**
 * FE-B2 evidence: built-in chat blocks / events / modes and the DOM of every block type in the
 * streaming, completed and error states (fixtures below), rendered through `BlockRenderer` and directly.
 *
 * Captured on the pre-refactor tree (side-effect registration into the Map-backed registries) and compared
 * field by field afterwards. Capture: W17_CAPTURE_CHAT_PLUGINS=1 (write-once).
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Block } from '@/features/chat/core/types/block';
import '@/features/chat/plugins';
import { blockRegistry, eventRegistry, modeRegistry } from '@/features/chat/registry';
import { BlockRenderer } from '@/features/chat/components/BlockRenderer';

const capture = process.env.W17_CAPTURE_CHAT_PLUGINS === '1';
const golden = (name: string, value: unknown) => {
  const file = `src/features/chat/plugins/__golden__/${name}.json`;
  if (capture) writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`, { flag: 'wx' });
  expect(value).toEqual(JSON.parse(readFileSync(file, 'utf8')));
};

const describeValue = (value: unknown): unknown => {
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value)) return value.map(describeValue);
  if (value && typeof value === 'object') {
    if ('$$typeof' in (value as object)) return 'component';
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, describeValue(v)]));
  }
  return value;
};

beforeAll(() => {
  // Snapshot the initial animation frame. A real rAF can race this traversal,
  // changing workspace_status height from 0px to auto under suite load.
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
});
afterAll(() => vi.useRealTimers());
afterEach(() => cleanup());

it('keeps the built-in block / event / mode inventory', () => {
  const sorted = <T,>(map: Map<string, T>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  golden('chat-plugin-inventory', {
    blocks: sorted(blockRegistry.getAll()).map(([key, plugin]) => ({ key, ...(describeValue(plugin) as object) })),
    events: sorted(eventRegistry.getAll()).map(([key, handler]) => ({ key, ...(describeValue(handler) as object) })),
    modes: sorted(modeRegistry.getAll()).map(([key, mode]) => ({ key, ...(describeValue(mode) as object) })),
  });
});

const OUTPUT = {
  summary: 'Fixture summary',
  items: [{ id: 'i1', title: 'Item one', snippet: 'First snippet', url: 'https://example.com/1', score: 0.9 }],
  sources: [{ id: 's1', title: 'Source one', snippet: 'Source snippet', url: 'https://example.com/s1' }],
  result: { status: 'ok', message: 'done' },
};

function fixture(type: string, state: 'streaming' | 'completed' | 'error'): { block: Block; isStreaming: boolean } {
  const block = {
    id: `blk-${type}`,
    type,
    messageId: 'msg-1',
    status: state === 'streaming' ? 'running' : state === 'completed' ? 'success' : 'error',
    content: 'Fixture **content** for the block.\n\n- point one\n- point two',
    toolName: 'builtin-sample_tool',
    toolInput: { query: 'fixture' },
    toolOutput: state === 'streaming' ? undefined : OUTPUT,
    error: state === 'error' ? 'fixture error' : undefined,
    startedAt: 1_699_999_990_000,
    endedAt: state === 'streaming' ? undefined : 1_699_999_995_000,
  } as Block;
  return { block, isStreaming: state === 'streaming' };
}

const STATES = ['streaming', 'completed', 'error'] as const;

async function html(element: React.ReactElement): Promise<string> {
  try {
    const view = render(element);
    await act(async () => { await Promise.resolve(); });
    // Shimmer animations write time-dependent inline styles.
    const out = view.container.innerHTML.replace(/background-position: [^;"]+/g, 'background-position: <animated>');
    view.unmount();
    return out;
  } catch (error) {
    cleanup();
    return `THROWN: ${error instanceof Error ? error.message : String(error)}`;
  }
}

it('keeps the DOM of every block type in the streaming / completed / error states', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const dom: Record<string, Record<string, { renderer: string; direct: string }>> = {};
  try {
    for (const type of [...blockRegistry.keys()].sort()) {
      const Component = blockRegistry.get(type)!.component;
      dom[type] = {};
      for (const state of STATES) {
        const { block, isStreaming } = fixture(type, state);
        dom[type][state] = {
          renderer: await html(<BlockRenderer block={block} isStreaming={isStreaming} />),
          direct: await html(<Component block={block} isStreaming={isStreaming} />),
        };
      }
    }
    const { block } = fixture('w17_unregistered_type', 'completed');
    dom.__unregistered__ = { completed: { renderer: await html(<BlockRenderer block={block} />), direct: '' } };
  } finally {
    consoleError.mockRestore();
  }
  golden('chat-block-dom', dom);
}, 120_000);
