import { describe, expect, it } from 'vitest';
import type { BackendEvents, WindowRef } from '../../../kernel/api.ts';
import {
  ACR_BRIDGE_PROGRESS_PREFIX, ACR_BRIDGE_RESPONSE_PREFIX, acrBridgeCall,
} from '../../agent-skills/api.ts';
import { backendEventBridge } from '../src/canvas-bridge.ts';

interface WindowSubscription {
  window: WindowRef;
  event: string;
  receive: (payload: unknown) => void;
  disposed: boolean;
}

/**
 * Minimal backend event host. It records the target of every subscription so
 * tests prove the bridge uses `listenWindow` and never app-level `listen`.
 */
class FakeBackendEvents implements BackendEvents {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly targeted: Array<{ target: { kind: string; label?: string }; event: string; payload: unknown }> = [];
  readonly windowSubscriptions: WindowSubscription[] = [];
  readonly appSubscriptions: string[] = [];
  onRequest: ((payload: Record<string, unknown>) => void) | undefined;

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  emitTo(target: { kind: string; label?: string }, event: string, payload: unknown): void {
    this.targeted.push({ target, event, payload });
    if (event === 'acr:bridge-request') {
      const request = payload as Record<string, unknown>;
      queueMicrotask(() => this.onRequest?.(request));
    }
  }

  listen(event: string): void {
    // App-scoped listeners are exactly the broadcast workaround being removed.
    this.appSubscriptions.push(event);
  }

  listenWindow(window: WindowRef, event: string, receive: (payload: unknown) => void): () => void {
    const subscription: WindowSubscription = { window, event, receive, disposed: false };
    this.windowSubscriptions.push(subscription);
    return () => {
      if (subscription.disposed) return;
      subscription.disposed = true;
    };
  }

  frontendEmit(event: string, payload: unknown): void {
    for (const subscription of this.windowSubscriptions) {
      if (!subscription.disposed && subscription.event === event) subscription.receive(payload);
    }
  }

  live(event: string): WindowSubscription[] {
    return this.windowSubscriptions.filter((s) => s.event === event && !s.disposed);
  }
}

const mainWindow: WindowRef = { window: 'main', webview: 'main' };

describe('canvas ACR backend event bridge', () => {
  it('routes response and progress through window-targeted listeners with disposers', () => {
    const events = new FakeBackendEvents();
    const bridge = backendEventBridge(events, () => mainWindow);
    const response = `${ACR_BRIDGE_RESPONSE_PREFIX}corr-1`;
    const progress = `${ACR_BRIDGE_PROGRESS_PREFIX}corr-1`;
    const seen: unknown[] = [];

    const disposeResponse = bridge.listen(response, (payload) => seen.push(['response', payload]));
    const disposeProgress = bridge.listen(progress, (payload) => seen.push(['progress', payload]));

    expect(events.windowSubscriptions.map((s) => ({ window: s.window, event: s.event })))
      .toEqual([
        { window: mainWindow, event: response },
        { window: mainWindow, event: progress },
      ]);
    expect(events.appSubscriptions).toEqual([]);
    expect(events.live('acr:bridge-response')).toEqual([]);

    events.frontendEmit(response, { id: 'r' });
    events.frontendEmit(progress, { id: 'p' });
    expect(seen).toEqual([
      ['response', { id: 'r' }],
      ['progress', { id: 'p' }],
    ]);

    disposeResponse();
    disposeResponse();
    disposeProgress();
    expect(events.live(response)).toEqual([]);
    expect(events.live(progress)).toEqual([]);
  });

  it('fails before subscribing when the calling window is unknown', () => {
    const events = new FakeBackendEvents();
    const bridge = backendEventBridge(events, () => null);
    expect(() => bridge.listen(`${ACR_BRIDGE_RESPONSE_PREFIX}x`, () => undefined))
      .toThrow(/requires the calling frontend window/);
    expect(events.windowSubscriptions).toEqual([]);
    expect(events.emitted).toEqual([]);
    expect(events.targeted).toEqual([]);
  });

  it('forwards progress chunks and resolves the correlated response', async () => {
    const events = new FakeBackendEvents();
    const bridge = backendEventBridge(events, () => mainWindow);
    const chunks: string[] = [];
    events.onRequest = (request) => {
      const correlationId = String(request.correlationId);
      const bridgeToken = String(request.bridgeToken);
      events.frontendEmit(`${ACR_BRIDGE_PROGRESS_PREFIX}${correlationId}`, {
        correlationId, bridgeToken, message: 'step 1',
      });
      events.frontendEmit(`${ACR_BRIDGE_PROGRESS_PREFIX}${correlationId}`, {
        correlationId, bridgeToken: 'wrong-token', message: 'must be ignored',
      });
      events.frontendEmit(`${ACR_BRIDGE_RESPONSE_PREFIX}${correlationId}`, {
        correlationId, bridgeToken, ok: true, data: { any: 'state' },
      });
    };

    const response = await acrBridgeCall({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      events: bridge,
      emitProgressChunk: (chunk) => chunks.push(chunk),
    }, 'query_state', {}, 1_000);

    expect(response).toMatchObject({ ok: true, data: { any: 'state' } });
    expect(events.targeted[0]).toMatchObject({
      target: { kind: 'Window', label: 'main' },
      event: 'acr:bridge-request',
    });
    expect(chunks).toEqual(['step 1\n']);
    // Both Rust ListenerGuard ids are released after the terminal response.
    expect(events.live(`${ACR_BRIDGE_RESPONSE_PREFIX}${response.correlationId}`)).toEqual([]);
    expect(events.live(`${ACR_BRIDGE_PROGRESS_PREFIX}${response.correlationId}`)).toEqual([]);
  });

  it('unlistens response and progress when the caller aborts', async () => {
    const events = new FakeBackendEvents();
    const bridge = backendEventBridge(events, () => mainWindow);
    const cancel = new AbortController();
    const pending = acrBridgeCall({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      events: bridge,
      cancel: cancel.signal,
      drainMs: 5,
    }, 'query_state', {}, 1_000);
    queueMicrotask(() => cancel.abort());
    await expect(pending).rejects.toThrow(/^CANCELLED: ACR bridge call cancelled/);
    expect(events.windowSubscriptions).toHaveLength(2);
    expect(events.windowSubscriptions.every((s) => s.disposed)).toBe(true);
  });
});
