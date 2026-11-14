import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HostRuntime } from '../../../kernel/runtime.ts';
import { ContractSet } from '../../../kernel/contracts.ts';
import type { BackendEvent } from '../../../kernel/protocol.ts';
import { BackendEventsSink, ChatV2Emitter, clearSessionSequenceCounter } from '../../../plugins/chat/api.ts';
import { installTauriBridge } from '../../../../electron/preload/bridge.ts';
import type { MainToRenderer } from '../../../../electron/shell/bridge-messages.ts';
import { ShellRuntime, type RuntimeOptions } from '../../../../electron/shell/runtime.ts';
import { eventPlugin } from '../../../../electron/shell/plugins/event.ts';
import type { WindowManager } from '../../../../electron/shell/windows.ts';

// Same downstream store-boundary instrumentation as the existing
// TauriAdapter.streamComplete.test.ts. Neither listen/core nor adapter is mocked.
const observed = vi.hoisted(() => ({
  blocks: vi.fn(), drain: vi.fn(), complete: vi.fn(async () => {}), abort: vi.fn(async () => {}),
}));
vi.mock('../../../../src/features/chat/core/middleware/eventBridge', () => ({
  handleBackendEventWithSequence: observed.blocks, flushPendingBackendEvents: observed.drain,
  handleStreamComplete: observed.complete, handleStreamAbort: observed.abort,
  clearEventContext: vi.fn(), resetBridgeState: vi.fn(),
}));
vi.mock('../../../../src/features/chat/core/middleware/autoSave', () => ({
  autoSave: { forceImmediateSave: vi.fn(async () => {}), cleanup: vi.fn() },
  streamingBlockSaver: { cleanup: vi.fn() },
}));

import { ChatV2TauriAdapter } from '../../../../src/features/chat/adapters/TauriAdapter';
import { chunkBuffer } from '../../../../src/features/chat/core/middleware/chunkBuffer';

describe('Host emitter → Electron shell/event + preload → official listen → real TauriAdapter (store boundary observed)', () => {
  let host: HostRuntime;
  const events: BackendEvent[] = [];
  let deliver: (message: MainToRenderer) => void;
  let runtime: ShellRuntime;
  let serial = 0;

  beforeAll(async () => {
    // No business plugin is installed in this isolated browser-side bridge test.
    // Real plugin loading/send reachability is tested in reachability.test.ts.
    host = new HostRuntime({ contracts: new ContractSet([]), app: {
      dataDir: '/tmp/opencode', version: 'x5', platform: 'linux', debug: true,
    }, outbound: { send(message) {
      if (message.kind !== 'event') throw new Error(`Unexpected Host message: ${message.kind}`);
      events.push(message);
    } } });
    // Only the OS/window transport is in-memory. Real runtime methods, listener
    // registry, plugin:event, serialization, preload and official listen run.
    runtime = new ShellRuntime({ platform: 'linux', debug: true, appVersion: 'x5', log() {},
      config: {}, paths: {}, assetScope: {}, fsScope: {},
    } as RuntimeOptions);
    runtime.windows = {
      labels: () => ['main'],
      get: () => ({ webContents: { isDestroyed: () => false,
        send: (_channel: string, message: MainToRenderer) => deliver(message) } }),
    } as unknown as WindowManager;
    runtime.registerPlugin('event', eventPlugin());
    installTauriBridge({
      subscribe: listener => { deliver = listener; },
      send: message => {
        if (message.type !== 'invoke') throw new Error(`Unexpected bridge message: ${message.type}`);
        if (message.payload.contentType !== 'application/json') throw new Error('Expected JSON invoke');
        const result = runtime.runBuiltin(message.cmd, {
          json: JSON.parse(message.payload.data as string), raw: null, headers: message.headers,
        }, { runtime, windowLabel: 'main', webviewLabel: 'main' });
        if (!result) throw new Error(`No builtin handler: ${message.cmd}`);
        result.then(value => deliver({ type: 'result', callbackId: message.callback, otherId: message.error,
          body: ShellRuntime.encodeBody(value) }), error => deliver({ type: 'result',
          callbackId: message.error, otherId: message.callback, body: ShellRuntime.encodeBody(error) }));
      },
    }, { osName: 'linux', windowLabel: 'main', webviewLabel: 'main', protocolScheme: 'http',
      sep: '/', delimiter: ':', dragDropEnabled: true }, window);
  });
  afterAll(async () => { await host?.dispose(); });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

  async function setup() {
    events.length = 0;
    const sessionId = `sess_bridge_${++serial}`;
    const store = {
      sessionId, currentStreamingMessageId: 'msg_x5', chatParams: { modelId: 'model_x5' },
      messageMap: new Map([['msg_x5', { id: 'msg_x5', role: 'assistant', blockIds: ['blk_x5'] }]]),
      blocks: new Map([['blk_x5', { id: 'blk_x5', messageId: 'msg_x5', type: 'content' }]]),
      completeStream: vi.fn(), updateMessageMeta: vi.fn(), setPendingParallelModelIds: vi.fn(),
    };
    const adapter = new ChatV2TauriAdapter(sessionId, store as any);
    const unlisten = await (adapter as any).registerEventListenersWithRollback();
    const emitter = new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), sessionId).withStreamGeneration(11);
    function forward() {
      // electron/main.ts:235 uses exactly this production emitTo entry point.
      for (const event of events.splice(0)) runtime.emitTo(event.target, event.event, JSON.stringify(event.payload));
    }
    return { store, emitter, forward, cleanup() {
      for (const stop of unlisten) stop();
      emitter.dispose(); clearSessionSequenceCounter(sessionId);
    } };
  }

  it('preserves exact block payloads and lets adapter settle success only after drain/flush', async () => {
    const f = await setup();
    vi.useFakeTimers();
    const order: string[] = [];
    observed.drain.mockImplementation(() => order.push('drain'));
    vi.spyOn(chunkBuffer, 'flushSession').mockImplementation(() => { order.push('flush'); });
    f.store.completeStream.mockImplementation(() => { order.push('complete'); });
    try {
      f.emitter.emitStreamStart('msg_x5', 'model_x5');
      f.emitter.emitStart('content', 'msg_x5', 'blk_x5', null, null);
      f.emitter.emitChunk('content', 'blk_x5', '尾部中文', null);
      f.emitter.emitEnd('content', 'blk_x5', { content: '尾部中文' }, null);
      f.emitter.emitStreamComplete('msg_x5', 12);
      const expected = JSON.parse(JSON.stringify(events.filter(e => e.event.includes('chat_v2_event_')).map(e => e.payload)));
      f.forward();
      expect(observed.blocks.mock.calls.map(args => args[1])).toEqual(expected);
      expect(f.store.completeStream).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(32);
      expect(order).toEqual(['drain', 'flush', 'complete']);
      expect(f.store.completeStream).toHaveBeenCalledWith('success');
    } finally { f.cleanup(); }
  });

  it.each(['error', 'cancelled'] as const)('consumes the real %s terminal without converting it to success', async kind => {
    const f = await setup();
    vi.useFakeTimers();
    vi.spyOn(chunkBuffer, 'flushSession').mockImplementation(() => {});
    try {
      f.emitter.emitStreamStart('msg_x5', null);
      if (kind === 'error') f.emitter.emitStreamError('msg_x5', 'X5 deterministic error');
      else f.emitter.emitStreamCancelled('msg_x5');
      f.forward();
      await vi.advanceTimersByTimeAsync(32);
      expect(f.store.completeStream.mock.calls[0]?.[0]).toBe(kind);
      expect(f.store.completeStream.mock.calls).toHaveLength(1);
      expect(observed.abort).toHaveBeenCalledOnce();
    } finally { f.cleanup(); }
  });

  it('rejects an old generation terminal after immediate same-message retry', async () => {
    const f = await setup();
    vi.useFakeTimers();
    vi.spyOn(chunkBuffer, 'flushSession').mockImplementation(() => {});
    try {
      f.emitter.emitStreamStart('msg_x5', null); f.forward();
      f.emitter.withStreamGeneration(12).emitStreamStart('msg_x5', null); f.forward();
      f.emitter.withStreamGeneration(11).emitStreamCancelled('msg_x5'); f.forward();
      expect(f.store.completeStream).not.toHaveBeenCalled();
      f.emitter.withStreamGeneration(12).emitStreamComplete('msg_x5', 4); f.forward();
      await vi.advanceTimersByTimeAsync(32);
      expect(f.store.completeStream).toHaveBeenCalledExactlyOnceWith('success');
    } finally { f.cleanup(); }
  });
});
