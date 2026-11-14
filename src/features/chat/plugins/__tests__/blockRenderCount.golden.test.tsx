/**
 * FE-B2 evidence: render counts of the message hot path (`BlockRendererWithStore` / `BlockRenderer`).
 *
 * Captured on the pre-refactor tree; afterwards every count must stay at or below the captured value.
 * Capture: W17_CAPTURE_CHAT_PLUGINS=1 (write-once).
 */
import React, { Profiler } from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Block } from '@/features/chat/core/types/block';
import type { ChatStore } from '@/features/chat/core/types';
import '@/features/chat/plugins/blocks/mcpTool';
import { blockRegistry, type BlockComponentProps } from '@/features/chat/registry';
import { BlockRenderer, BlockRendererWithStore } from '@/features/chat/components/BlockRenderer';

afterEach(() => cleanup());

const counts = { probe: 0, mcp: 0, plain: 0 };
const Probe: React.FC<BlockComponentProps> = ({ block }) => {
  counts.probe++;
  return <div data-probe>{block.content}</div>;
};
const PlainProbe: React.FC<BlockComponentProps> = ({ block }) => {
  counts.plain++;
  return <div data-plain>{block.content}</div>;
};

const blocks = (...list: Block[]) => new Map(list.map((b) => [b.id, b]));
const probeBlock = (content: string): Block => ({ id: 'probe', type: 'w17_probe', status: 'running', messageId: 'm', content } as Block);
const mcpBlock = (status: Block['status']): Block => ({
  id: 'mcp', type: 'mcp_tool', status, messageId: 'm', toolName: 'builtin-sample_tool', toolInput: {}, startedAt: 1, endedAt: status === 'success' ? 2 : undefined,
  toolOutput: status === 'success' ? { ok: true } : undefined,
} as Block);
const otherBlock = (content: string): Block => ({ id: 'other', type: 'content', status: 'running', messageId: 'm', content } as Block);

it('does not render the message hot path more often', () => {
  const offProbe = blockRegistry.register('w17_probe', { type: 'w17_probe', component: Probe });
  const offPlain = blockRegistry.register('w17_plain', { type: 'w17_plain', component: PlainProbe });
  try {
    const store = createStore(() => ({
      blocks: blocks(probeBlock('a'), mcpBlock('running'), otherBlock('x')),
      activeBlockIds: new Set<string>(['probe']),
    })) as unknown as StoreApi<ChatStore>;
    const set = (patch: Partial<{ blocks: Map<string, Block>; activeBlockIds: Set<string> }>) =>
      act(() => (store as unknown as StoreApi<typeof patch>).setState(patch));
    const plain = { id: 'plain', type: 'w17_plain', status: 'success', messageId: 'm', content: 'p' } as Block;
    const Tree = ({ tick, plainBlock }: { tick: number; plainBlock: Block }) => (
      <div data-tick={tick}>
        <BlockRendererWithStore store={store} blockId="probe" />
        <Profiler id="mcp" onRender={() => { counts.mcp++; }}>
          <BlockRendererWithStore store={store} blockId="mcp" />
        </Profiler>
        <BlockRenderer block={plainBlock} />
      </div>
    );
    const steps: Record<string, typeof counts> = {};
    const snap = (step: string) => { steps[step] = { ...counts }; };

    const view = render(<Tree tick={0} plainBlock={plain} />);
    snap('mount');
    const state = () => store.getState() as unknown as { blocks: Map<string, Block> };
    set({ blocks: new Map(state().blocks).set('other', otherBlock('xy')) });
    snap('update-unrelated-block');
    set({ blocks: new Map(state().blocks).set('probe', probeBlock('ab')) });
    snap('update-probe-block');
    set({ blocks: new Map(state().blocks).set('mcp', mcpBlock('success')) });
    snap('update-mcp-block');
    set({ activeBlockIds: new Set() });
    snap('probe-stops-streaming');
    let offUnrelated: unknown;
    act(() => { offUnrelated = blockRegistry.register('w17_unrelated', { type: 'w17_unrelated', component: Probe }); });
    snap('register-unrelated-type');
    act(() => { if (typeof offUnrelated === 'function') offUnrelated(); else blockRegistry.unregister('w17_unrelated'); });
    snap('unregister-unrelated-type');
    view.rerender(<Tree tick={1} plainBlock={plain} />);
    snap('parent-rerender-same-props');
    view.rerender(<Tree tick={2} plainBlock={{ ...plain, content: 'q' }} />);
    snap('plain-block-new-reference');

    const file = 'src/features/chat/plugins/__golden__/block-render-counts.json';
    if (process.env.W17_CAPTURE_CHAT_PLUGINS === '1') writeFileSync(file, `${JSON.stringify(steps, null, 1)}\n`, { flag: 'wx' });
    const baseline = JSON.parse(readFileSync(file, 'utf8')) as typeof steps;
    expect(Object.keys(steps)).toEqual(Object.keys(baseline));
    for (const [step, value] of Object.entries(steps)) {
      for (const key of Object.keys(value) as (keyof typeof counts)[]) {
        expect({ step, key, count: value[key] }).toEqual({ step, key, count: Math.min(value[key], baseline[step]![key]) });
      }
    }
  } finally {
    if (typeof offProbe === 'function') offProbe(); else blockRegistry.unregister('w17_probe');
    if (typeof offPlain === 'function') offPlain(); else blockRegistry.unregister('w17_plain');
  }
});
