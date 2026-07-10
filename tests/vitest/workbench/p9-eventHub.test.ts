/**
 * P9 — core/eventHub 单一订阅中枢测试
 *
 * 核心保证：同一事件名重复 hubListen 不产生重复 Tauri listener；
 * keyed 路由按 sessionId/resourceId 精准分发；最后订阅者离开自动 unlisten。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import {
  hubListen,
  hubListenKeyed,
  setHubKeyExtractor,
  defaultHubKeyExtractor,
  getEventHubDiagnostics,
  resetEventHub,
} from '@/features/workbench/core/eventHub';

type TauriHandler = (event: { payload: unknown }) => void;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('P9 eventHub', () => {
  let tauriHandlers: Map<string, TauriHandler>;
  let unlistenSpies: Map<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    resetEventHub();
    tauriHandlers = new Map();
    unlistenSpies = new Map();
    listenMock.mockReset();
    listenMock.mockImplementation(async (name: string, cb: TauriHandler) => {
      tauriHandlers.set(name, cb);
      const unlisten = vi.fn(() => {
        tauriHandlers.delete(name);
      });
      unlistenSpies.set(name, unlisten);
      return unlisten;
    });
  });

  afterEach(() => {
    resetEventHub();
  });

  const emit = (name: string, payload: unknown) => {
    tauriHandlers.get(name)?.({ payload });
  };

  it('同一事件名重复 hubListen 只产生一个 Tauri listener，且全部收到广播', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    hubListen('evt://stream', h1);
    hubListen('evt://stream', h2);
    hubListenKeyed('evt://stream', 'sess_a', h3);
    await flush();

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith('evt://stream', expect.any(Function));

    emit('evt://stream', { sessionId: 'sess_a', chunk: 1 });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  it('keyed 订阅按 sessionId / session_id / resourceId 路由，不串扰', async () => {
    const a = vi.fn();
    const b = vi.fn();
    hubListenKeyed('evt://keyed', 'sess_a', a);
    hubListenKeyed('evt://keyed', 'res_b', b);
    await flush();

    emit('evt://keyed', { sessionId: 'sess_a', v: 1 });
    emit('evt://keyed', { session_id: 'sess_a', v: 2 });
    emit('evt://keyed', { resourceId: 'res_b', v: 3 });
    emit('evt://keyed', { resource_id: 'res_b', v: 4 });
    emit('evt://keyed', { sessionId: 'sess_other', v: 5 });
    emit('evt://keyed', 'not-an-object');

    expect(a).toHaveBeenCalledTimes(2);
    expect(a).toHaveBeenNthCalledWith(1, { sessionId: 'sess_a', v: 1 });
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('setHubKeyExtractor 定制键提取覆盖默认字段探测', async () => {
    const restore = setHubKeyExtractor('evt://custom', (payload) => {
      const obj = payload as { meta?: { session?: string } };
      return obj?.meta?.session ?? null;
    });
    const handler = vi.fn();
    hubListenKeyed('evt://custom', 'sess_x', handler);
    await flush();

    emit('evt://custom', { meta: { session: 'sess_x' } });
    emit('evt://custom', { sessionId: 'sess_x' }); // 默认字段不再生效
    expect(handler).toHaveBeenCalledTimes(1);

    restore();
    emit('evt://custom', { sessionId: 'sess_x' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('最后一个订阅者取消后自动 unlisten 并回收 entry', async () => {
    const d1 = hubListen('evt://gone', vi.fn());
    const d2 = hubListenKeyed('evt://gone', 'k', vi.fn());
    await flush();

    const unlisten = unlistenSpies.get('evt://gone')!;
    d1();
    expect(unlisten).not.toHaveBeenCalled();
    d2();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(getEventHubDiagnostics()).toHaveLength(0);

    // 重复 dispose 无副作用
    d2();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('拆除后重新订阅会建立新的 Tauri listener', async () => {
    const dispose = hubListen('evt://again', vi.fn());
    await flush();
    dispose();

    const handler = vi.fn();
    hubListen('evt://again', handler);
    await flush();

    expect(listenMock).toHaveBeenCalledTimes(2);
    emit('evt://again', { v: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('listen Promise 挂起期间全部订阅者离开 → resolve 后立即 unlisten', async () => {
    let resolveListen!: (fn: () => void) => void;
    listenMock.mockImplementationOnce(
      () => new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );
    const dispose = hubListen('evt://race', vi.fn());
    dispose();

    const unlisten = vi.fn();
    resolveListen(unlisten);
    await flush();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(getEventHubDiagnostics()).toHaveLength(0);
  });

  it('某个 handler 抛错不影响其余订阅者', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    hubListen('evt://err', bad);
    hubListen('evt://err', good);
    await flush();

    emit('evt://err', { v: 1 });
    expect(good).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('resetEventHub 拆除全部 listener', async () => {
    hubListen('evt://a', vi.fn());
    hubListen('evt://b', vi.fn());
    await flush();

    resetEventHub();
    expect(unlistenSpies.get('evt://a')).toHaveBeenCalledTimes(1);
    expect(unlistenSpies.get('evt://b')).toHaveBeenCalledTimes(1);
    expect(getEventHubDiagnostics()).toHaveLength(0);
  });

  it('defaultHubKeyExtractor 覆盖常用业务键字段', () => {
    expect(defaultHubKeyExtractor({ sessionId: 's1' })).toBe('s1');
    expect(defaultHubKeyExtractor({ session_id: 's2' })).toBe('s2');
    expect(defaultHubKeyExtractor({ resourceId: 'r1' })).toBe('r1');
    expect(defaultHubKeyExtractor({ resource_id: 'r2' })).toBe('r2');
    expect(defaultHubKeyExtractor({ documentId: 'd1' })).toBe('d1');
    expect(defaultHubKeyExtractor({ document_id: 'd2' })).toBe('d2');
    expect(defaultHubKeyExtractor({ id: 'x' })).toBe('x');
    expect(defaultHubKeyExtractor({ other: 'x' })).toBeNull();
    expect(defaultHubKeyExtractor(null)).toBeNull();
    expect(defaultHubKeyExtractor('str')).toBeNull();
    // 优先级：sessionId 先于 id
    expect(defaultHubKeyExtractor({ id: 'x', sessionId: 's' })).toBe('s');
  });
});
