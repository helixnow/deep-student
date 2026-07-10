/**
 * R1-19 — bridge 路由规格：correlation 响应 + ≤5Hz 进度节流
 *
 * 以 types.ts 事件常量与 DESIGN §2.1 为准；mock `@tauri-apps/api/event`。
 * 与 R1-07 bridge.test.ts 互补：本文件为 R1-19 任务卡点名入口。
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
import {
  ACR_EVENT_PROGRESS_PREFIX,
  ACR_EVENT_REQUEST,
  ACR_EVENT_RESPONSE_PREFIX,
} from '../types';

type EventHandler = (event: { payload: AcrBridgeRequest }) => void;

function progressEmitCount(): number {
  return vi.mocked(emit).mock.calls.filter((c) =>
    String(c[0]).startsWith(ACR_EVENT_PROGRESS_PREFIX),
  ).length;
}

describe('ACR bridgeRouting — correlation + 5Hz', () => {
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
      correlationId: 'corr-route',
      ok: true,
      data: { state: 'clean', windowId: 'w1' },
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
    await vi.waitFor(() => {
      expect(listen).toHaveBeenCalledWith(ACR_EVENT_REQUEST, expect.any(Function));
      expect(requestHandler).not.toBeNull();
    });
  }

  it('request → handleBridgeRequest → response 事件名带同一 correlationId', async () => {
    await flushListenRegistration();

    const req: AcrBridgeRequest = {
      correlationId: 'corr-route',
      command: 'probe',
      args: { target: { typeId: 'note', resourceId: 'n1' } },
      timeoutMs: 3000,
      runId: 'run-route',
      sessionId: 'sess-route',
    };

    requestHandler!({ payload: req });

    await vi.waitFor(() => {
      expect(stageManager.handleBridgeRequest).toHaveBeenCalledWith(req);
      expect(emit).toHaveBeenCalledWith(
        `${ACR_EVENT_RESPONSE_PREFIX}corr-route`,
        expect.objectContaining({
          correlationId: 'corr-route',
          ok: true,
        }),
      );
    });
  });

  it('handleBridgeRequest 抛错时仍 emit ok:false 且 correlation 对齐', async () => {
    await flushListenRegistration();
    vi.mocked(stageManager.handleBridgeRequest).mockRejectedValueOnce(new Error('boom'));

    requestHandler!({
      payload: {
        correlationId: 'corr-err',
        command: 'probe',
        args: {},
        timeoutMs: 1000,
        runId: 'run-err',
        sessionId: 'sess',
      },
    });

    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(`${ACR_EVENT_RESPONSE_PREFIX}corr-err`, {
        correlationId: 'corr-err',
        ok: false,
        error: 'boom',
      });
    });
  });

  it('进度 ≤5Hz：200ms 窗口内尾随合并，step 取 max', async () => {
    await flushListenRegistration();

    emitAcrProgress('corr-hz', 1, 4, 'a');
    await vi.waitFor(() => {
      expect(progressEmitCount()).toBe(1);
    });

    emitAcrProgress('corr-hz', 2, 4, 'b');
    emitAcrProgress('corr-hz', 4, 4, 'd');
    emitAcrProgress('corr-hz', 3, 4, 'c-late');
    expect(progressEmitCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(200);

    await vi.waitFor(() => {
      expect(progressEmitCount()).toBe(2);
      const last = vi
        .mocked(emit)
        .mock.calls.filter((c) => String(c[0]).startsWith(ACR_EVENT_PROGRESS_PREFIX))
        .at(-1)?.[1];
      expect(last).toEqual({
        correlationId: 'corr-hz',
        step: 4,
        total: 4,
        message: 'c-late',
        entityId: undefined,
      });
    });
  });

  it('不同 correlationId 的进度互不合并', async () => {
    await flushListenRegistration();

    emitAcrProgress('corr-a', 1, 2, 'a1');
    emitAcrProgress('corr-b', 1, 2, 'b1');
    // flushProgress 内动态 import 是微任务；fake timers 下需显式冲刷
    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() => {
      const names = vi
        .mocked(emit)
        .mock.calls.map((c) => String(c[0]))
        .filter((n) => n.startsWith(ACR_EVENT_PROGRESS_PREFIX));
      expect(names).toContain(`${ACR_EVENT_PROGRESS_PREFIX}corr-a`);
      expect(names).toContain(`${ACR_EVENT_PROGRESS_PREFIX}corr-b`);
    });
  });

  it('teardown 调用 unlisten 并清空节流', async () => {
    await flushListenRegistration();
    emitAcrProgress('corr-teardown', 1, 1, 'x');
    await vi.waitFor(() => expect(progressEmitCount()).toBeGreaterThan(0));

    teardown?.();
    teardown = null;
    expect(unlisten).toHaveBeenCalled();

    vi.mocked(emit).mockClear();
    emitAcrProgress('corr-teardown', 2, 1, 'y');
    // 节流已清：首条再次立即发（仍可 emit；验证不抛且可再次节流）
    await vi.waitFor(() => {
      expect(progressEmitCount()).toBe(1);
    });
  });
});
