/**
 * WP-F：输入框入队 → 中止等待；followup:* 点击（空闲发送 / 流式入队 + 中止等待）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createStore, type StoreApi } from 'zustand';
import type { ChatStore } from '@/features/chat/core/types';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/chat/readiness/readinessGate', () => ({
  resolveChatReadiness: vi.fn(async () => ({ ok: true })),
  triggerOpenSettingsModels: vi.fn(),
}));

import { useInputBarV2 } from '@/features/chat/components/input-bar/useInputBarV2';
import {
  collectLivePendingGenerativeUiAwaits,
  dismissPendingGenerativeUiAwait,
} from '@/features/generative-ui/bridge/genuiAwaitRuntime';
import { resolveGenerativeUIChatActionHandlers } from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
import { collectFollowupActions } from '@/features/generative-ui/handlers/followupActionHandlers';

const SESSION_ID = 'sess_follow';

function pendingGenuiBlock(toolCallId = 'call-1') {
  return {
    id: `blk-${toolCallId}`,
    messageId: 'msg-1',
    type: 'generative_ui',
    status: 'running',
    toolCallId,
    content: '',
    toolOutput: {
      awaitAnswer: true,
      interaction: { mode: 'await', toolCallId, state: 'pending' },
    },
  };
}

interface Harness {
  store: StoreApi<ChatStore>;
  enqueueMessage: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function makeChatStore(opts: {
  sessionStatus: string;
  blocks?: Array<ReturnType<typeof pendingGenuiBlock>>;
  withMaybeDequeue?: boolean;
}): Harness {
  const sendMessage = vi.fn(async () => undefined);
  const enqueueMessage = vi.fn((content: string, attachments: unknown[], contextRefs: unknown[]) => {
    store.setState({
      queuedMessages: [
        ...(store.getState().queuedMessages ?? []),
        { id: `q${Date.now()}`, content, attachments, contextRefs, createdAt: 0, status: 'pending' },
      ],
    } as Partial<ChatStore>);
  });
  const store = createStore<ChatStore>(
    () =>
      ({
        sessionId: SESSION_ID,
        sessionStatus: opts.sessionStatus,
        blocks: new Map((opts.blocks ?? []).map((b) => [b.id, b])),
        queuedMessages: [],
        inputValue: '我直接在对话框回答',
        attachments: [],
        panelStates: {},
        permissionPresetSyncing: false,
        pendingContextRefs: [],
        setInputValue: vi.fn((value: string) => store.setState({ inputValue: value } as Partial<ChatStore>)),
        setPendingParallelModelIds: vi.fn(),
        clearAttachments: vi.fn(),
        canSend: () => opts.sessionStatus === 'idle',
        enqueueMessage,
        sendMessage,
        ...(opts.withMaybeDequeue
          ? {
              maybeDequeue: vi.fn(async () => {
                const [head, ...rest] = store.getState().queuedMessages;
                if (!head) return;
                store.setState({ queuedMessages: rest } as Partial<ChatStore>);
                await sendMessage(head.content, head.attachments);
              }),
            }
          : {}),
      }) as unknown as ChatStore,
  );
  return { store, enqueueMessage, sendMessage };
}

const FOLLOWUP_INTENT: GenerativeUIIntent = {
  version: '1',
  blocks: [
    {
      type: 'action-bar',
      props: {
        actions: [
          { id: 'followup:more', label: '再来 3 道', prompt: '再出 3 道同类题', variant: 'default', riskLevel: 'low' },
          { id: 'copy-intent', label: '复制', variant: 'default', riskLevel: 'low' },
        ],
      },
    },
  ],
} as unknown as GenerativeUIIntent;

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('genuiAwaitRuntime', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ status: 'accepted' });
  });

  it('collects only live pending generative_ui awaits', () => {
    const { store } = makeChatStore({
      sessionStatus: 'streaming',
      blocks: [
        pendingGenuiBlock('call-1'),
        { ...pendingGenuiBlock('call-2'), status: 'success' }, // 不是 live（需 list_pending 判定）
        {
          ...pendingGenuiBlock('call-3'),
          toolOutput: { interaction: { mode: 'await', toolCallId: 'call-3', state: 'answered' } },
        },
      ],
    });
    expect(collectLivePendingGenerativeUiAwaits(store)).toEqual(['call-1']);
    expect(collectLivePendingGenerativeUiAwaits(store.getState())).toEqual(['call-1']);
  });

  it('dismissPendingGenerativeUiAwait dismisses with the given reason', async () => {
    const { store } = makeChatStore({ sessionStatus: 'streaming', blocks: [pendingGenuiBlock()] });
    await expect(dismissPendingGenerativeUiAwait(store, 'user_message')).resolves.toEqual(['call-1']);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_genui_dismiss_answer', {
      sessionId: SESSION_ID,
      toolCallId: 'call-1',
      reason: 'user_message',
    });
  });

  it('no pending await → no IPC', async () => {
    const { store } = makeChatStore({ sessionStatus: 'streaming' });
    await expect(dismissPendingGenerativeUiAwait(store, 'user_message')).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('useInputBarV2 enqueue during a pending await', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ status: 'accepted' });
  });

  it('enqueues the message and dismisses the await with user_message', async () => {
    const { store, enqueueMessage } = makeChatStore({
      sessionStatus: 'streaming',
      blocks: [pendingGenuiBlock()],
    });
    const { result } = renderHook(() => useInputBarV2(store, { queueEnabled: true }));
    await act(async () => {
      await result.current.sendMessage();
    });
    await flush();
    expect(enqueueMessage).toHaveBeenCalledWith('我直接在对话框回答', [], []);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_genui_dismiss_answer', {
      sessionId: SESSION_ID,
      toolCallId: 'call-1',
      reason: 'user_message',
    });
  });

  it('enqueue without a pending await does not call dismiss', async () => {
    const { store, enqueueMessage } = makeChatStore({ sessionStatus: 'streaming' });
    const { result } = renderHook(() => useInputBarV2(store, { queueEnabled: true }));
    await act(async () => {
      await result.current.sendMessage();
    });
    await flush();
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('followup:* action handlers', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ status: 'accepted' });
  });

  it('collects valid followups only', () => {
    const intent = {
      version: '1',
      blocks: [
        {
          type: 'action-bar',
          props: {
            actions: [
              { id: 'followup:ok', label: 'ok', prompt: 'go' },
              { id: 'followup:Bad', label: 'bad id', prompt: 'x' },
              { id: 'followup:noprompt', label: 'no prompt' },
              { id: 'followup:long', label: 'long', prompt: 'x'.repeat(501) },
            ],
          },
        },
      ],
    } as unknown as GenerativeUIIntent;
    expect(collectFollowupActions(intent).map((a) => a.id)).toEqual(['followup:ok']);
  });

  it('is not registered without a chat store', () => {
    const handlers = resolveGenerativeUIChatActionHandlers({ intent: FOLLOWUP_INTENT });
    expect(Object.hasOwn(handlers, 'followup:more')).toBe(false);
  });

  it('idle: sends the prompt as a user message (via queue drain)', async () => {
    const { store, sendMessage } = makeChatStore({ sessionStatus: 'idle', withMaybeDequeue: true });
    const handlers = resolveGenerativeUIChatActionHandlers({ intent: FOLLOWUP_INTENT, chatStore: store });
    expect(handlers['followup:more'].label).toBe('再来 3 道');
    expect(handlers['followup:more'].riskLevel).toBe('low');
    await handlers['followup:more'].handler();
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('再出 3 道同类题', []);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('idle without maybeDequeue: sendMessage directly', async () => {
    const { store, sendMessage, enqueueMessage } = makeChatStore({ sessionStatus: 'idle' });
    const handlers = resolveGenerativeUIChatActionHandlers({ intent: FOLLOWUP_INTENT, chatStore: store });
    await handlers['followup:more'].handler();
    await flush();
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('再出 3 道同类题', []);
  });

  it('streaming: enqueues the prompt and dismisses the pending await', async () => {
    const { store, sendMessage, enqueueMessage } = makeChatStore({
      sessionStatus: 'streaming',
      blocks: [pendingGenuiBlock()],
      withMaybeDequeue: true,
    });
    const handlers = resolveGenerativeUIChatActionHandlers({ intent: FOLLOWUP_INTENT, chatStore: store });
    await handlers['followup:more'].handler();
    await flush();
    expect(enqueueMessage).toHaveBeenCalledWith('再出 3 道同类题', [], []);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_genui_dismiss_answer', {
      sessionId: SESSION_ID,
      toolCallId: 'call-1',
      reason: 'user_message',
    });
  });
});
