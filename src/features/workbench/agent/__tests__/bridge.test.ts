/**
 * R1-07 — AgentBridge 请求/响应 correlation 与进度 ≤5Hz 节流
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../stageManager', () => ({
  stageManager: {
    handleBridgeRequest: vi.fn(),
  },
}));

import { emit, listen } from '@tauri-apps/api/event';
import { stageManager } from '../stageManager';
import {
  __resetAcrProgressThrottleForTests,
  emitAcrProgress,
  setupAgentBridge,
} from '../bridge';
import type { AcrBridgeRequest, AcrBridgeResponse } from '../types';
import { ACR_EVENT_PROGRESS_PREFIX, ACR_EVENT_REQUEST, ACR_EVENT_RESPONSE_PREFIX } from '../types';

type EventHandler = (event: { payload: AcrBridgeRequest }) => void;

describe('ACR bridge', () => {
  let requestHandler: EventHandler | null = null;
  let unlisten: ReturnType<typeof vi.fn>;
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __resetAcrProgressThrottleForTests();
    requestHandler = null;
    unlisten = vi.fn();

    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      if (eventName === ACR_EVENT_REQUEST) {
        requestHandler = handler as EventHandler;
      }
      return unlisten;
    });
    vi.mocked(emit).mockResolvedValue(undefined);
    vi.mocked(stageManager.handleBridgeRequest).mockResolvedValue({
      correlationId: 'corr-1',
      ok: true,
      data: { state: 'clean' },
    } satisfies AcrBridgeResponse);

    teardown = setupAgentBridge();
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    __resetAcrProgressThrottleForTests();
    vi.useRealTimers();
  });

  async function flushListenRegistration(): Promise<void> {
    // setupAgentBridge 经动态 import().then(listen) 注册
    await vi.waitFor(() => {
      expect(listen).toHaveBeenCalled();
      expect(requestHandler).not.toBeNull();
    });
  }

  it('请求 → handleBridgeRequest → emit 带 correlation 的响应（并广播诊断事件）', async () => {
    await flushListenRegistration();

    const req: AcrBridgeRequest = {
      correlationId: 'corr-1',
      command: 'probe',
      args: { target: { typeId: 'note' } },
      timeoutMs: 3000,
      runId: 'run-1',
      sessionId: 'sess-1',
    };

    requestHandler!({ payload: req });

    await vi.waitFor(() => {
      expect(stageManager.handleBridgeRequest).toHaveBeenCalledWith(req);
      expect(emit).toHaveBeenCalledWith(`${ACR_EVENT_RESPONSE_PREFIX}corr-1`, {
        correlationId: 'corr-1',
        ok: true,
        data: { state: 'clean' },
      });
      expect(emit).toHaveBeenCalledWith('acr:bridge-response', {
        correlationId: 'corr-1',
        ok: true,
        data: { state: 'clean' },
      });
    });
  });

  it('进度按 correlationId ≤5Hz 尾随合并，step 单调取 max', async () => {
    await flushListenRegistration();

    emitAcrProgress('corr-p', 1, 10, 'step-1');
    // 首条：距 lastEmit=0，立即发出
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(`${ACR_EVENT_PROGRESS_PREFIX}corr-p`, {
        correlationId: 'corr-p',
        step: 1,
        total: 10,
        message: 'step-1',
        entityId: undefined,
      });
    });

    const emitCountAfterFirst = vi.mocked(emit).mock.calls.filter((c) =>
      String(c[0]).startsWith(ACR_EVENT_PROGRESS_PREFIX),
    ).length;
    expect(emitCountAfterFirst).toBe(1);

    // 窗口内多次调用：只保留最后一条，但 step 取 max(2,5)=5，message 为最后一条
    emitAcrProgress('corr-p', 2, 10, 'step-2');
    emitAcrProgress('corr-p', 5, 10, 'step-5');
    emitAcrProgress('corr-p', 3, 10, 'step-3-late');

    // 尚未到 200ms，不应再发
    expect(
      vi.mocked(emit).mock.calls.filter((c) => String(c[0]).startsWith(ACR_EVENT_PROGRESS_PREFIX))
        .length,
    ).toBe(1);

    await vi.advanceTimersByTimeAsync(200);

    await vi.waitFor(() => {
      const progressCalls = vi
        .mocked(emit)
        .mock.calls.filter((c) => String(c[0]).startsWith(ACR_EVENT_PROGRESS_PREFIX));
      expect(progressCalls.length).toBe(2);
      expect(progressCalls[1][1]).toEqual({
        correlationId: 'corr-p',
        step: 5, // max(2,5,3)
        total: 10,
        message: 'step-3-late',
        entityId: undefined,
      });
    });
  });

  it('flushes trailing progress before response and resets completed correlation state', async () => {
    await flushListenRegistration();

    let resolveRequest!: (response: AcrBridgeResponse) => void;
    vi.mocked(stageManager.handleBridgeRequest).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    requestHandler!({
      payload: {
        correlationId: 'corr-tail',
        command: 'probe',
        args: { target: { typeId: 'note' } },
        timeoutMs: 3000,
        runId: 'run-tail',
        sessionId: 'sess-tail',
      },
    });

    emitAcrProgress('corr-tail', 1, 3, 'step-1');
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(
        `${ACR_EVENT_PROGRESS_PREFIX}corr-tail`,
        expect.objectContaining({ step: 1 }),
      );
    });
    emitAcrProgress('corr-tail', 2, 3, 'step-2');

    resolveRequest({
      correlationId: 'corr-tail',
      ok: true,
      data: { state: 'clean' },
    });

    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(
        `${ACR_EVENT_RESPONSE_PREFIX}corr-tail`,
        expect.objectContaining({ ok: true }),
      );
    });

    const calls = vi.mocked(emit).mock.calls;
    const trailingIndex = calls.findIndex(
      ([event, payload]) =>
        event === `${ACR_EVENT_PROGRESS_PREFIX}corr-tail` &&
        (payload as { step?: number }).step === 2,
    );
    const responseIndex = calls.findIndex(
      ([event]) => event === `${ACR_EVENT_RESPONSE_PREFIX}corr-tail`,
    );
    expect(trailingIndex).toBeGreaterThanOrEqual(0);
    expect(trailingIndex).toBeLessThan(responseIndex);

    emitAcrProgress('corr-tail', 3, 3, 'step-3-after-complete');
    await vi.waitFor(() => {
      const progressCalls = vi.mocked(emit).mock.calls.filter(
        ([event]) => event === `${ACR_EVENT_PROGRESS_PREFIX}corr-tail`,
      );
      expect(progressCalls).toHaveLength(3);
    });
  });


  it('cleans correlation progress state when request handling fails', async () => {
    await flushListenRegistration();
    vi.mocked(stageManager.handleBridgeRequest).mockRejectedValueOnce(new Error('failed-tail'));

    requestHandler!({
      payload: {
        correlationId: 'corr-tail-error',
        command: 'probe',
        args: {},
        timeoutMs: 3000,
        runId: 'run-tail-error',
        sessionId: 'sess-tail-error',
      },
    });
    emitAcrProgress('corr-tail-error', 1, 3, 'step-1');
    emitAcrProgress('corr-tail-error', 2, 3, 'step-2');

    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(`${ACR_EVENT_RESPONSE_PREFIX}corr-tail-error`, {
        correlationId: 'corr-tail-error',
        ok: false,
        error: 'failed-tail',
      });
    });
    expect(emit).toHaveBeenCalledWith(
      `${ACR_EVENT_PROGRESS_PREFIX}corr-tail-error`,
      expect.objectContaining({ step: 2 }),
    );

    emitAcrProgress('corr-tail-error', 3, 3, 'step-3-after-error');
    await vi.waitFor(() => {
      const progressCalls = vi.mocked(emit).mock.calls.filter(
        ([event]) => event === `${ACR_EVENT_PROGRESS_PREFIX}corr-tail-error`,
      );
      expect(progressCalls).toHaveLength(3);
    });
  });

  it('卸载时调用 unlisten', async () => {
    await flushListenRegistration();
    teardown?.();
    teardown = null;
    expect(unlisten).toHaveBeenCalled();
  });
});
