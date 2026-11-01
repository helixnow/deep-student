import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import {
  InlineGenerativeUIFence,
  resolveInlineGenerativeUIFenceState,
} from '@/features/generative-ui/inline/InlineGenerativeUIFence';
import {
  parseInlineOpenPdfActionId,
  resolveInlineActionHandlers,
} from '@/features/generative-ui/inline/resolveInlineActionHandlers';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

const STAT = { type: 'stat-card', id: 's1', props: { title: '正确率', value: '82%' } };
const TEXT = { type: 'text', id: 't1', props: { body: '第二块正文' } };

const json = (intent: unknown) => JSON.stringify(intent);

describe('resolveInlineGenerativeUIFenceState', () => {
  it('renders a complete, inline-safe intent', () => {
    const state = resolveInlineGenerativeUIFenceState(json({ version: '1', blocks: [STAT, TEXT] }), false);
    expect(state.kind).toBe('render');
    if (state.kind === 'render') {
      expect(state.partial).toBe(false);
      expect(state.intent.blocks).toHaveLength(2);
    }
  });

  it('streaming: renders only closed blocks', () => {
    const full = json({ version: '1', blocks: [STAT, TEXT] });
    // 截在第二块中间：只有第一块已闭合
    const cut = full.slice(0, full.indexOf('第二块') + 2);
    const state = resolveInlineGenerativeUIFenceState(cut, true);
    expect(state.kind).toBe('render');
    if (state.kind === 'render') {
      expect(state.partial).toBe(true);
      expect(state.intent.blocks.map((b) => b.type)).toEqual(['stat-card']);
    }
  });

  it('streaming with no closed block → pending placeholder', () => {
    expect(resolveInlineGenerativeUIFenceState('{"version":"1","blocks":[{"type":"stat', true)).toEqual({
      kind: 'pending',
    });
    expect(resolveInlineGenerativeUIFenceState('', true)).toEqual({ kind: 'pending' });
  });

  it('after streaming ends, unparsable JSON falls back to source', () => {
    expect(resolveInlineGenerativeUIFenceState('{"version":"1","blocks":[{"type":"stat', false).kind).toBe(
      'fallback',
    );
    expect(resolveInlineGenerativeUIFenceState('not json', false).kind).toBe('fallback');
  });

  it('interactive blocks / forbidden actions / fields fall back to source', () => {
    const choice = {
      type: 'choice',
      id: 'q1',
      props: { question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    };
    expect(resolveInlineGenerativeUIFenceState(json({ version: '1', blocks: [STAT, choice] }), false).kind).toBe(
      'fallback',
    );
    const followup = {
      type: 'action-bar',
      props: { actions: [{ id: 'followup:more', label: '再来', prompt: '再出一题' }] },
    };
    expect(resolveInlineGenerativeUIFenceState(json({ version: '1', blocks: [followup] }), false).kind).toBe(
      'fallback',
    );
    const applyEdit = { type: 'action-bar', props: { actions: [{ id: 'apply-note-edit', label: '应用' }] } };
    expect(resolveInlineGenerativeUIFenceState(json({ version: '1', blocks: [applyEdit] }), false).kind).toBe(
      'fallback',
    );
    expect(
      resolveInlineGenerativeUIFenceState(
        json({ version: '1', blocks: [STAT], meta: { researchSessionId: 'r1' } }),
        false,
      ).kind,
    ).toBe('fallback');
  });

  it('streaming: a closed forbidden block falls back immediately', () => {
    const choice = {
      type: 'choice',
      id: 'q1',
      props: { question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    };
    const full = json({ version: '1', blocks: [choice, TEXT] });
    const cut = full.slice(0, full.indexOf('第二块'));
    expect(resolveInlineGenerativeUIFenceState(cut, true).kind).toBe('fallback');
  });
});

describe('InlineGenerativeUIFence', () => {
  it('renders blocks via the display-only renderer', () => {
    const { container } = render(
      <InlineGenerativeUIFence source={json({ version: '1', blocks: [STAT, TEXT] })} isStreaming={false} />,
    );
    expect(container.querySelector('[data-inline-genui="render"]')).not.toBeNull();
    expect(container.querySelector('[data-generative-ui]')).not.toBeNull();
    expect(screen.getByText('82%')).toBeTruthy();
    expect(screen.getByText('第二块正文')).toBeTruthy();
    // 内联不显示 AI chrome（accept/regenerate）
    expect(container.querySelector('[data-generative-ui-chrome]')).toBeNull();
  });

  it('shows the generating placeholder while no block is closed', () => {
    const { container } = render(<InlineGenerativeUIFence source={'{"version":"1","blocks":['} isStreaming />);
    expect(container.querySelector('[data-inline-genui="pending"]')).not.toBeNull();
    expect(container.querySelector('[data-generative-ui]')).toBeNull();
  });

  it('streaming renders only closed blocks', () => {
    const full = json({ version: '1', blocks: [STAT, TEXT] });
    const cut = full.slice(0, full.indexOf('第二块') + 2);
    render(<InlineGenerativeUIFence source={cut} isStreaming />);
    expect(screen.getByText('82%')).toBeTruthy();
    expect(screen.queryByText('第二块正文')).toBeNull();
  });

  it('invalid source → source view + one-line warning', () => {
    const { container } = render(
      <InlineGenerativeUIFence
        source="{oops"
        isStreaming={false}
        renderSource={() => <pre data-testid="src">{'{oops'}</pre>}
      />,
    );
    expect(container.querySelector('[data-inline-genui="fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-inline-genui-warning]')).not.toBeNull();
    expect(screen.getByTestId('src').textContent).toBe('{oops');
    expect(container.querySelector('[data-generative-ui]')).toBeNull();
  });

  it('only inline-safe action buttons are rendered', () => {
    const bar = {
      type: 'action-bar',
      props: {
        actions: [
          { id: 'copy-intent', label: '复制意图' },
          { id: 'open-note:note_1', label: '打开笔记' },
        ],
      },
    };
    render(<InlineGenerativeUIFence source={json({ version: '1', blocks: [STAT, bar] })} isStreaming={false} />);
    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons.some((t) => t.includes('复制意图') || /copy/i.test(t))).toBe(true);
    expect(buttons.some((t) => t.includes('打开笔记') || /open note/i.test(t))).toBe(true);
  });
});

describe('resolveInlineActionHandlers', () => {
  const intentWith = (ids: string[]): GenerativeUIIntent => ({
    version: '1',
    blocks: [
      { type: 'action-bar', props: { actions: ids.map((id) => ({ id, label: id })) } },
    ],
  });

  it('only builds handlers for inline-safe actions', () => {
    const handlers = resolveInlineActionHandlers(
      intentWith([
        'copy-block',
        'copy-intent',
        'open-note:note_1',
        'open-pdf:res_1',
        'open-pdf-page:res_2:3',
        'apply-note-edit',
        'dismiss-note-suggestion',
        'export-intent',
        'copy-report',
        'followup:more',
        'start-review',
        'open-note:../etc',
      ]),
    );
    expect(Object.keys(handlers).sort()).toEqual(
      ['copy-block', 'copy-intent', 'open-note:note_1', 'open-pdf-page:res_2:3', 'open-pdf:res_1'].sort(),
    );
    for (const def of Object.values(handlers)) expect(def.riskLevel).toBe('low');
  });

  it('returns an (empty) registry even without action bars', () => {
    const handlers = resolveInlineActionHandlers({ version: '1', blocks: [STAT] });
    expect(handlers).toBeTruthy();
    expect(Object.keys(handlers)).toEqual([]);
  });

  it('open-pdf:<id> navigates to page 1', async () => {
    const listener = vi.fn();
    document.addEventListener('pdf-ref:open', listener);
    const handlers = resolveInlineActionHandlers(intentWith(['open-pdf:res_9']));
    await handlers['open-pdf:res_9']!.handler();
    document.removeEventListener('pdf-ref:open', listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ sourceId: 'res_9', pageNumber: 1 });
  });

  it('parseInlineOpenPdfActionId rejects malformed ids', () => {
    expect(parseInlineOpenPdfActionId('open-pdf:res_1')).toBe('res_1');
    expect(parseInlineOpenPdfActionId('open-pdf:')).toBeNull();
    expect(parseInlineOpenPdfActionId('open-pdf:a/b')).toBeNull();
    expect(parseInlineOpenPdfActionId('open-pdf-page:res_1:2')).toBeNull();
  });
});
