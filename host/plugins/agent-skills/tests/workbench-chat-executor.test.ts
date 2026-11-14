import { describe, expect, it } from 'vitest';
import type { BackendEvents, WindowRef } from '../../../kernel/api.ts';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { sessionScopedRunId } from '../src/workbench-bridge.ts';
import { WorkbenchChatToolExecutor, workbenchGateEnvironment } from '../src/tools/workbench-chat-executor.ts';
import { HINT_DISABLED, HINT_FLAG_OFF, type WorkbenchGateEnvironment } from '../src/tools/workbench-executor.ts';

const OBSERVE = { revision: 'rev-1', windowId: 'win-1', typeId: 'note' };
const MAIN: WindowRef = { window: 'main', webview: 'main' };

function windowEvents(onRequest: (request: Record<string, unknown>) => void) {
  const emitted: unknown[][] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const fire = (event: string, payload: unknown) => { for (const handler of listeners.get(event) ?? []) handler(payload); };
  const events = {
    emitTo(target: unknown, event: string, payload: unknown) {
      emitted.push([target, event, payload]);
      if (event === 'acr:bridge-request') onRequest(payload as Record<string, unknown>);
    },
    listenWindow(window: WindowRef, event: string, receive: (payload: unknown) => void) {
      emitted.push(['listen', window, event]);
      const key = `${window.window}:${event}`;
      let set = listeners.get(key);
      if (set === undefined) listeners.set(key, (set = new Set()));
      set.add(receive);
      return () => { listeners.get(key)?.delete(receive); };
    },
  } as unknown as BackendEvents;
  const fireWindow = (event: string, payload: unknown) => fire(`main:${event}`, payload);
  return { events, emitted, fireWindow, listeners };
}

function chatContext(window: WindowRef | null) {
  const record: unknown[][] = [], saved: ToolResultInfo[] = [];
  const ctx = {
    session_id: 'sess-1', block_id: 'blk-1', cancellation_token: null,
    runId: () => 'run-1', tryWindow: () => window,
    emitter: { emitChunk: (...args: unknown[]) => record.push(['chunk', ...args]) },
    emitToolCallStart: (...args: unknown[]) => record.push(['start', ...args]),
    emitToolCallEnd: (payload: unknown) => record.push(['end', payload]),
    emitToolCallError: (error: string) => record.push(['error', error]),
    saveToolBlock: (result: ToolResultInfo) => { saved.push(result); },
  } as unknown as ExecutionContext;
  return { ctx, record, saved };
}

const enabled: WorkbenchGateEnvironment = { featureFlagEnabled: () => true, settings: { get: () => null } };

describe('roster.rs:126 WorkbenchToolExecutor on the chat ExecutionContext', () => {
  it('delegates name, routing, sensitivity, serial concurrency and managed cancellation to the Rust-parity core', () => {
    const executor = new WorkbenchChatToolExecutor({ events: () => ({}) as BackendEvents, gates: () => enabled, logger: {} });
    expect([executor.name(), executor.canHandle('builtin-workbench_observe'), executor.canHandle('builtin-web_fetch')])
      .toEqual(['WorkbenchToolExecutor', true, false]);
    expect(['workbench_observe', 'workbench_act', 'workbench_act_high'].map(name => executor.sensitivityLevel(name)))
      .toEqual(['low', 'medium', 'high']);
    expect([executor.concurrencyClass('workbench_observe'), executor.managesCancellation('workbench_observe')]).toEqual(['serial', true]);
  });

  it('runs the bridge on the calling window with run_id identity, forwarding progress as tool_call chunks', async () => {
    const bus = windowEvents(request => {
      queueMicrotask(() => {
        const identity = { correlationId: request.correlationId, bridgeToken: request.bridgeToken };
        bus.fireWindow(`acr:bridge-progress:${String(request.correlationId)}`, { ...identity, message: 'step 1' });
        bus.fireWindow(`acr:bridge-response:${String(request.correlationId)}`, { ...identity, ok: true, data: OBSERVE });
      });
    });
    const executor = new WorkbenchChatToolExecutor({ events: () => bus.events, gates: () => enabled, logger: {} });
    const { ctx, record, saved } = chatContext(MAIN);
    const result = await executor.execute({ id: 'call-llm', name: 'builtin-workbench_observe', arguments: { type_id: 'note' } }, ctx);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ success: true, toolCallId: 'call-llm', blockId: 'blk-1', output: OBSERVE });
    expect(saved).toEqual([result]);
    const request = bus.emitted.find(entry => entry[1] === 'acr:bridge-request')!;
    expect(request[0]).toEqual({ kind: 'Window', label: 'main' });
    expect(request[2]).toMatchObject({ toolCallId: 'run-1', sessionId: 'sess-1', runId: sessionScopedRunId('sess-1', 'run-1'),
      command: 'observe', args: { typeId: 'note' } });
    expect(bus.emitted.filter(entry => entry[0] === 'listen').map(entry => entry[1])).toEqual([MAIN, MAIN]);
    expect(record.map(entry => entry[0])).toEqual(['start', 'chunk', 'end']);
    expect(record[1]).toEqual(['chunk', 'tool_call', 'blk-1', 'step 1\n', null]);
    expect([...bus.listeners.values()].every(set => set.size === 0)).toBe(true);
  });

  it('a windowless context fails WORKBENCH_UNAVAILABLE before emitting any request', async () => {
    const bus = windowEvents(() => { throw new Error('must not emit'); });
    const executor = new WorkbenchChatToolExecutor({ events: () => bus.events, gates: () => enabled, logger: {} });
    const { ctx, saved } = chatContext(null);
    const result = await executor.execute({ id: 'c', name: 'workbench_observe', arguments: {} }, ctx);
    expect(result.success).toBe(false);
    expect(JSON.parse(result.error!)).toMatchObject({ code: 'WORKBENCH_UNAVAILABLE',
      message: expect.stringContaining('ACR bridge requires the calling frontend window (ExecutionContext.window_ref)') });
    expect(bus.emitted).toEqual([]);
    expect(saved).toHaveLength(1);
  });

  it('missing gate sources fail WORKBENCH_UNAVAILABLE; the flag and the control setting drive the double gate', async () => {
    const bus = windowEvents(() => { throw new Error('must not emit'); });
    const unavailable = new WorkbenchChatToolExecutor({ events: () => bus.events, gates: () => null, logger: {} });
    const failed = await unavailable.execute({ id: 'c', name: 'workbench_observe', arguments: {} }, chatContext(MAIN).ctx);
    expect(JSON.parse(failed.error!)).toMatchObject({ code: 'WORKBENCH_UNAVAILABLE', message: 'AppState 不可用' });

    const values = new Map<string, string>([['desktop.workbenchAgentControl', 'off']]);
    const settings = { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { values.set(key, value); } };
    const loads: unknown[][] = [];
    let flag = false;
    const featureFlags = { load: (_store: unknown, version: string, options: unknown) => {
      loads.push([version, options]);
      return { isFeatureEnabled: (name: string) => name === 'tools.workbench_agent' && flag };
    } };
    expect(workbenchGateEnvironment({ settings: settings as never, app: { version: '1', debug: false } })).toBeNull();
    const gates = workbenchGateEnvironment({ settings: settings as never, featureFlags: featureFlags as never, app: { version: '9.9', debug: true } });
    const gated = new WorkbenchChatToolExecutor({ events: () => bus.events, gates: () => gates, logger: {} });
    const off = await gated.execute({ id: 'c', name: 'workbench_open_app', arguments: {} }, chatContext(MAIN).ctx);
    expect(JSON.parse(off.error!)).toMatchObject({ code: 'WORKBENCH_DISABLED', hint: HINT_FLAG_OFF });
    flag = true;
    const disabled = await gated.execute({ id: 'c', name: 'workbench_open_app', arguments: {} }, chatContext(MAIN).ctx);
    expect(JSON.parse(disabled.error!)).toMatchObject({ code: 'WORKBENCH_DISABLED', hint: HINT_DISABLED });
    expect(loads).toEqual([['9.9', { debug: true }], ['9.9', { debug: true }]]);
    expect(bus.emitted).toEqual([]);
  });
});
