/**
 * Super 会话 × 生成式 UI 等待作答（方案 2.7）：
 * - 等待作答期间（流仍活跃）不投递 inbox；
 * - 用户改在输入框回复 → 后端 yieldTurn 结束本轮 → 先出队用户消息，该回合结束后才投递。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand';
import type { DeliverOutcome } from '../../core/types';
import {
  SuperResidentController,
  isReadyForDelivery,
  type ResidentChatState,
  type ResidentControllerDeps,
} from '../residentController';
import { superResidentStore } from '../residentState';
import type { SuperSessionInboxChangedPayload, SuperSessionState } from '../api';

type Deliver = (opts?: { force?: boolean }) => Promise<DeliverOutcome>;
type QueuedItem = ResidentChatState['queuedMessages'][number];

const pendingGenuiBlock = {
  id: 'blk-genui',
  messageId: 'msg_a',
  type: 'generative_ui',
  status: 'running',
  toolCallId: 'call-1',
  toolOutput: {
    awaitAnswer: true,
    interaction: { mode: 'await', toolCallId: 'call-1', state: 'pending' },
  },
};

function makeHarness() {
  const timeline: string[] = [];
  const deliver = vi.fn<Deliver>(async () => {
    timeline.push('deliver');
    return { status: 'empty' };
  });
  const store: StoreApi<ResidentChatState> = createStore<ResidentChatState>(() => ({
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    queuedMessages: [],
    isDataLoaded: true,
    messageOrder: [],
    messageMap: new Map(),
    pendingBlockingInteraction: null,
    deliverSuperInbox: (o) => deliver(o),
  }));
  let inbox: ((p: SuperSessionInboxChangedPayload) => void) | null = null;
  const backendState: SuperSessionState = {
    enabled: true,
    sessionId: 'sess_super',
    workspaceId: 'ws_super',
    pendingInbox: 0,
  };
  const deps: ResidentControllerDeps = {
    isMainWindow: () => true,
    waitUntilReady: async () => undefined,
    getState: async () => ({ ...backendState }),
    onChanged: async () => () => undefined,
    onInboxChanged: async (handler) => {
      inbox = handler;
      return () => {
        inbox = null;
      };
    },
    onAgentCompletion: async () => () => undefined,
    getOrCreateStore: () => store,
    acquireAdapter: async () => ({ release: () => undefined }),
    restoreExecutions: async () => undefined,
  };
  return {
    deps,
    store,
    deliver,
    timeline,
    emitInbox: (p: SuperSessionInboxChangedPayload) => inbox?.(p),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('SuperResidentController × generative UI await', () => {
  let controller: SuperResidentController | null = null;

  beforeEach(() => {
    superResidentStore.setState({
      sessionId: null,
      workspaceId: null,
      pendingInbox: 0,
      pausedReason: null,
      autoTurns: 0,
      resuming: false,
    });
  });

  afterEach(async () => {
    await controller?.stop();
    controller = null;
  });

  it('is not ready for delivery while a genui await keeps the stream alive', () => {
    const state = {
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_a',
      queuedMessages: [],
      pendingBlockingInteraction: null,
      blocks: new Map([[pendingGenuiBlock.id, pendingGenuiBlock]]),
    } as unknown as ResidentChatState;
    expect(isReadyForDelivery(state)).toBe(false);
  });

  it('does not deliver during the await; after yield the queued user message goes first, then delivery', async () => {
    const h = makeHarness();
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();
    h.deliver.mockClear();
    h.timeline.length = 0;

    // 1) 模型调用 render_generative_ui(awaitAnswer) → 流挂起等待作答
    h.store.setState({ sessionStatus: 'streaming', currentStreamingMessageId: 'msg_a' });
    h.emitInbox({ sessionId: 'sess_super', pendingInbox: 1 });
    await flush();
    expect(isReadyForDelivery(h.store.getState())).toBe(false);
    expect(h.deliver).not.toHaveBeenCalled();

    // 2) 用户改在输入框回复：消息入队（随后 dismiss(user_message) → 后端 yieldTurn）
    h.store.setState({ queuedMessages: [{ id: 'q1', content: '我直接说' } as unknown as QueuedItem] });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    // 3) 本轮以 yieldTurn 结束 → 空闲但用户队列非空：用户消息优先，不投递
    h.store.setState({ sessionStatus: 'idle', currentStreamingMessageId: null });
    await flush();
    expect(isReadyForDelivery(h.store.getState())).toBe(false);
    expect(h.deliver).not.toHaveBeenCalled();

    // 4) 队列出队发送用户消息 → 新回合流式中：仍不投递
    h.timeline.push('dequeue_user_message');
    h.store.setState({ queuedMessages: [], sessionStatus: 'streaming', currentStreamingMessageId: 'msg_b' });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    // 5) 用户消息回合结束 → 空闲且队列为空 → 投递一次
    h.store.setState({ sessionStatus: 'idle', currentStreamingMessageId: null });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.timeline).toEqual(['dequeue_user_message', 'deliver']);
  });
});
