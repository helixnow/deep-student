/**
 * WP-F：generative_ui 块组件 ↔ 交互绑定（readGenerativeUIInteraction + list_pending + submit/skip）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import React from 'react';
import { createStore } from 'zustand';
import type { Block, ChatStore } from '@/features/chat/core/types';
import type { GenerativeUIRendererProps } from '@/features/generative-ui/types';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const rendererProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('@/features/generative-ui/GenerativeUIRenderer', () => ({
  GenerativeUIRenderer: (props: Record<string, unknown>) => {
    rendererProps.last = props;
    return <div data-testid="genui-renderer" />;
  },
}));
vi.mock('@/features/generative-ui/hooks/useHpiasEventBridge', () => ({ useHpiasEventBridge: vi.fn() }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

import { GenerativeUIBlockComponent } from '@/features/chat/plugins/blocks/generativeUI';

const SESSION_ID = 'sess_block';

const INTENT = {
  version: '1',
  blocks: [
    {
      type: 'choice',
      id: 'q1',
      props: { question: '选哪个？', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    },
  ],
};

function makeStore(sessionStatus: string) {
  return createStore<ChatStore>(() => ({ sessionId: SESSION_ID, sessionStatus, modeState: null }) as unknown as ChatStore);
}

function lastProps(): GenerativeUIRendererProps {
  if (!rendererProps.last) throw new Error('renderer not rendered');
  return rendererProps.last as unknown as GenerativeUIRendererProps;
}

function liveAwaitBlock(): Block {
  return {
    id: 'blk-1',
    messageId: 'msg-1',
    type: 'generative_ui',
    status: 'running',
    toolCallId: 'call-1',
    content: JSON.stringify(INTENT),
    toolOutput: {
      awaitAnswer: true,
      interaction: { mode: 'await', toolCallId: 'call-1', state: 'pending' },
    },
  } as Block;
}

describe('GenerativeUIBlockComponent interaction binding', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    rendererProps.last = null;
  });

  it('live await while streaming: submittable, renders non-streaming, no list_pending IPC', () => {
    const store = makeStore('streaming');
    render(<GenerativeUIBlockComponent block={liveAwaitBlock()} isStreaming store={store} />);
    const props = lastProps();
    expect(props.interaction).toMatchObject({ state: 'pending', canSubmit: true });
    expect(typeof props.interaction?.onSubmit).toBe('function');
    expect(typeof props.interaction?.onSkip).toBe('function');
    expect(props.isStreaming).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('DB-restored pending with empty list_pending → interrupted (queried once)', async () => {
    invokeMock.mockResolvedValue([]);
    const store = makeStore('idle');
    const block = {
      id: 'blk-db',
      messageId: 'msg-1',
      type: 'generative_ui',
      status: 'success',
      toolCallId: 'call-db',
      content: '',
      toolInput: { intent: INTENT, awaitAnswer: true },
      toolOutput: {
        status: 'not_answered',
        answered: false,
        reason: 'interrupted',
        interaction: { mode: 'await', toolCallId: 'call-db', state: 'pending' },
      },
    } as unknown as Block;
    const { rerender } = render(<GenerativeUIBlockComponent block={block} store={store} />);
    expect(lastProps().interaction).toMatchObject({ state: 'pending', canSubmit: false });

    await waitFor(() => expect(lastProps().interaction?.state).toBe('interrupted'));
    expect(lastProps().interaction?.canSubmit).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_genui_list_pending_answers', { sessionId: SESSION_ID });

    rerender(<GenerativeUIBlockComponent block={{ ...block }} store={store} />);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('DB-restored pending still live in backend → submittable', async () => {
    invokeMock.mockResolvedValue(['call-db']);
    const store = makeStore('idle');
    const block = {
      id: 'blk-db',
      messageId: 'msg-1',
      type: 'generative_ui',
      status: 'success',
      toolCallId: 'call-db',
      toolInput: { intent: INTENT, awaitAnswer: true },
      toolOutput: { interaction: { mode: 'await', toolCallId: 'call-db', state: 'pending' } },
    } as unknown as Block;
    render(<GenerativeUIBlockComponent block={block} store={store} />);
    await waitFor(() => expect(lastProps().interaction?.canSubmit).toBe(true));
  });

  it('submit invokes chat_v2_genui_submit_answer once with camelCase args', async () => {
    invokeMock.mockResolvedValue({ status: 'accepted' });
    const store = makeStore('streaming');
    render(<GenerativeUIBlockComponent block={liveAwaitBlock()} isStreaming store={store} />);
    const binding = lastProps().interaction!;
    const payload = { summary: '选了 B', data: { q1: { selected: ['b'] } } };

    let results: unknown[] = [];
    await act(async () => {
      results = await Promise.all([binding.onSubmit!(payload), binding.onSubmit!(payload)]);
    });
    await act(async () => {
      results.push(await binding.onSubmit!(payload));
    });

    expect(results).toEqual(['accepted', 'accepted', 'accepted']);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_genui_submit_answer', {
      sessionId: SESSION_ID,
      toolCallId: 'call-1',
      summary: '选了 B',
      data: { q1: { selected: ['b'] } },
    });
  });

  it('GENUI_ANSWER_INVALID maps to { invalid } and allows resubmission', async () => {
    invokeMock.mockRejectedValueOnce('GENUI_ANSWER_INVALID: q1 需要选择 1 项');
    invokeMock.mockResolvedValueOnce({ status: 'accepted' });
    const store = makeStore('streaming');
    render(<GenerativeUIBlockComponent block={liveAwaitBlock()} isStreaming store={store} />);
    const binding = lastProps().interaction!;
    const payload = { summary: 's', data: { q1: { selected: [] } } };

    await expect(binding.onSubmit!(payload)).resolves.toEqual({ invalid: 'q1 需要选择 1 项' });
    await act(async () => {
      await Promise.resolve();
    });
    await expect(binding.onSubmit!(payload)).resolves.toBe('accepted');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('skip dismisses with reason skipped', async () => {
    invokeMock.mockResolvedValue({ status: 'accepted' });
    const store = makeStore('streaming');
    render(<GenerativeUIBlockComponent block={liveAwaitBlock()} isStreaming store={store} />);
    await act(async () => {
      await lastProps().interaction!.onSkip!();
    });
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_genui_dismiss_answer', {
      sessionId: SESSION_ID,
      toolCallId: 'call-1',
      reason: 'skipped',
    });
  });

  it('answered replay is read-only with summary', () => {
    const store = makeStore('idle');
    const block = {
      id: 'blk-ans',
      messageId: 'msg-1',
      type: 'generative_ui',
      status: 'success',
      toolCallId: 'call-a',
      toolInput: { intent: INTENT, awaitAnswer: true },
      toolOutput: {
        interaction: { mode: 'await', toolCallId: 'call-a', state: 'answered' },
        answer: { summary: '选了 A', data: { q1: { selected: ['a'] } } },
      },
    } as unknown as Block;
    render(<GenerativeUIBlockComponent block={block} store={store} />);
    expect(lastProps().interaction).toMatchObject({
      state: 'answered',
      canSubmit: false,
      answered: { summary: '选了 A' },
    });
    expect(lastProps().interaction?.onSubmit).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('error block with pending interaction and no answer → cancelled (stopped)', () => {
    const store = makeStore('idle');
    const block = { ...liveAwaitBlock(), status: 'error', error: 'Stream cancelled' } as Block;
    render(<GenerativeUIBlockComponent block={block} store={store} />);
    expect(lastProps().interaction).toMatchObject({ state: 'cancelled', reason: 'stopped', canSubmit: false });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('preparing block streams only closed blocks extracted from tool args', () => {
    const store = makeStore('streaming');
    const args =
      '{"awaitAnswer":true,"intent":{"version":"1","blocks":[{"type":"text","props":{"body":"第一块"}},{"type":"text","props":{"body":"半截';
    const block = {
      id: 'prep-x',
      messageId: 'msg-1',
      type: 'generative_ui',
      status: 'pending',
      isPreparing: true,
      toolCallId: 'call-p',
      content: args,
    } as Block;
    render(<GenerativeUIBlockComponent block={block} isStreaming store={store} />);
    const props = lastProps();
    expect(props.isStreaming).toBe(true);
    expect(props.interaction).toBeUndefined();
    const intent = props.intent as { blocks: Array<{ props: { body: string } }> };
    expect(intent.blocks).toHaveLength(1);
    expect(intent.blocks[0].props.body).toBe('第一块');
  });
});
