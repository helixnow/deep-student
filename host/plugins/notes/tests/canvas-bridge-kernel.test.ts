// ACR 窗口定向的最小验证：走正式 kernel `BackendEvents`（target 语义），而不是只按事件名分发
// 的测试替身。覆盖 F1 `listenWindow` 的 Tauri target 路由：
// - 请求只发往调用窗口（`Window { label }`）；
// - 广播（前端 `emit` 转发的 target Any）能被窗口监听者收到；
// - 发往其他窗口的事件不会泄漏给本窗口监听者；
// - 终止/取消后响应与进度监听器都被释放。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WindowRef } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import {
  ACR_BRIDGE_PROGRESS_PREFIX, ACR_BRIDGE_RESPONSE_PREFIX, acrBridgeCall,
} from '../../agent-skills/api.ts';
import { backendEventBridge } from '../src/canvas-bridge.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;

const windowOne: WindowRef = { window: 'w1', webview: 'w1' };
const windowTwo: WindowRef = { window: 'w2', webview: 'w2' };

let host: Host;

beforeAll(async () => {
  host = await createTestHost();
});

afterAll(async () => {
  await host.dispose();
});

function uuidSequence(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

function lastBridgeRequest(hostRef: Host) {
  return hostRef.events.filter((message) => message.event === 'acr:bridge-request').at(-1);
}

describe('canvas ACR on formal BackendEvents target routing', () => {
  it('receives broadcast replies but not replies targeted at another window', async () => {
    const bridge = backendEventBridge(host.ctx.backendEvents, () => windowOne);
    const chunks: string[] = [];
    const pending = acrBridgeCall({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      events: bridge,
      emitProgressChunk: (chunk) => chunks.push(chunk),
      uuid: uuidSequence('corr-1', 'token-1'),
    }, 'query_state', {}, 1_000);

    expect(lastBridgeRequest(host)?.target).toEqual({ kind: 'Window', label: 'w1' });

    const progressEvent = `${ACR_BRIDGE_PROGRESS_PREFIX}corr-1`;
    const responseEvent = `${ACR_BRIDGE_RESPONSE_PREFIX}corr-1`;

    // 发往 w2 的事件不能到达 w1 的响应/进度监听器。
    host.emitFrontend(progressEvent, {
      correlationId: 'corr-1', bridgeToken: 'token-1', message: 'other window',
    }, windowTwo, { kind: 'Window', label: 'w2' });
    expect(chunks).toEqual([]);

    // 前端 `emit` 由 electron/shell/plugins/event.ts 转发为 target Any，广播必须到达窗口监听者；
    // source 是 w2 也不影响接收（Tauri 以 target 而非 source 判定）。
    host.emitFrontend(progressEvent, {
      correlationId: 'corr-1', bridgeToken: 'token-1', message: 'step 1',
    }, windowTwo, { kind: 'Any' });
    expect(chunks).toEqual(['step 1\n']);

    host.emitFrontend(responseEvent, {
      correlationId: 'corr-1', bridgeToken: 'token-1', ok: true, data: { any: 'state' },
    }, windowTwo, { kind: 'Any' });
    await expect(pending).resolves.toMatchObject({ ok: true, data: { any: 'state' } });

    // 终止响应已释放正式 BackendEvents 上的两个监听器：之后的广播不得再进入处理器。
    host.emitFrontend(progressEvent, {
      correlationId: 'corr-1', bridgeToken: 'token-1', message: 'after cleanup',
    }, windowOne, { kind: 'Any' });
    expect(chunks).toEqual(['step 1\n']);
  });

  it('delivers backend broadcasts to the window listener, ignores other windows, and disposes idempotently', () => {
    const bridge = backendEventBridge(host.ctx.backendEvents, () => windowOne);
    const seen: unknown[] = [];
    const dispose = bridge.listen('acr:test-broadcast', (payload) => seen.push(payload));

    host.ctx.backendEvents.emit('acr:test-broadcast', { via: 'broadcast' });
    host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'w2' }, 'acr:test-broadcast', { via: 'w2' });
    expect(seen).toEqual([{ via: 'broadcast' }]);

    dispose();
    dispose();
    host.ctx.backendEvents.emit('acr:test-broadcast', { via: 'after-dispose' });
    expect(seen).toEqual([{ via: 'broadcast' }]);
  });

  it('removes the window listeners when the caller cancels', async () => {
    const bridge = backendEventBridge(host.ctx.backendEvents, () => windowOne);
    const chunks: string[] = [];
    const cancel = new AbortController();
    const pending = acrBridgeCall({
      sessionId: 'session-2',
      toolCallId: 'call-2',
      events: bridge,
      emitProgressChunk: (chunk) => chunks.push(chunk),
      cancel: cancel.signal,
      drainMs: 5,
      uuid: uuidSequence('corr-2', 'token-2'),
    }, 'query_state', {}, 1_000);

    cancel.abort();
    await expect(pending).rejects.toThrow(/^CANCELLED: ACR bridge call cancelled/);

    host.emitFrontend(`${ACR_BRIDGE_PROGRESS_PREFIX}corr-2`, {
      correlationId: 'corr-2', bridgeToken: 'token-2', message: 'after abort',
    }, windowOne, { kind: 'Any' });
    expect(chunks).toEqual([]);
  });
});
