import { describe, expect, it } from 'vitest';
import {
  ACR_BRIDGE_CANCEL, ACR_BRIDGE_REQUEST, acrBridgeCall,
  clampBridgeTimeout, applyOpsTimeoutMs, uncertainApplyReceipt, isValidApplyReceipt,
  sessionScopedRunId, parseBridgeResponse, isValidCommandData, isBridgeCancelled,
  isBridgeResultUnknown,
} from '../src/workbench-bridge.ts';
import type { BridgeEventBus } from '../src/workbench-bridge.ts';
import type { AcrBridgeRequest, AcrBridgeResponse, AcrProgress } from '../api.ts';

interface FakeBus extends BridgeEventBus {
  emitted: Array<{ event: string; payload: unknown }>;
  fire(event: string, payload: unknown): void;
  listenerCount(): number;
}

function fakeBus(): FakeBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const bus: FakeBus = {
    emitted: [],
    emit(event, payload) {
      bus.emitted.push({ event, payload });
      bus.fire(event, payload);
    },
    fire(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    listen(event, handler) {
      let set = listeners.get(event);
      if (set === undefined) listeners.set(event, (set = new Set()));
      set.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
  return bus;
}

function callContext(bus: FakeBus, cancel?: AbortSignal) {
  return {
    sessionId: 'sess-xyz',
    toolCallId: 'run-abc',
    events: bus,
    ...(cancel === undefined ? {} : { cancel }),
    uuid: (() => {
      let n = 0;
      return () => `uuid-${++n}`;
    })(),
    drainMs: 20,
  };
}

function respond(bus: FakeBus, payload: unknown): void {
  const request = bus.emitted.find(entry => entry.event === ACR_BRIDGE_REQUEST)?.payload as AcrBridgeRequest;
  bus.fire(`acr:bridge-response:${request.correlationId}`, payload);
}

describe('workbench_bridge.rs', () => {
  it('acr_bridge_request_round_trip', () => {
    const request: AcrBridgeRequest = { correlationId: 'corr-1', bridgeToken: 'token-1', command: 'probe', args: { target: { typeId: 'note', resourceId: 'n1' } }, timeoutMs: 3000, runId: 'acr3:8:sess-xyz:run-abc', toolCallId: 'run-abc', sessionId: 'sess-xyz' };
    const serialized = JSON.parse(JSON.stringify(request));
    expect(serialized.correlationId).toBe('corr-1');
    expect(serialized.timeoutMs).toBe(3000);
    expect(serialized.bridgeToken).toBe('token-1');
    expect(serialized.runId).toBe('acr3:8:sess-xyz:run-abc');
    expect(serialized.toolCallId).toBe('run-abc');
    expect(serialized.sessionId).toBe('sess-xyz');
    expect(serialized).not.toHaveProperty('correlation_id');
    expect(serialized).toEqual(request);
  });
  it('acr_bridge_response_round_trip', () => {
    const response: AcrBridgeResponse = { correlationId: 'corr-2', bridgeToken: 'token-2', ok: true, data: { status: 'completed', mode: 'frontend', applied: 1, totalOps: 1, entityIds: ['e1'], done: ['ok'], undone: [] } };
    const serialized = JSON.parse(JSON.stringify(response));
    expect(serialized.correlationId).toBe('corr-2');
    expect(serialized.ok).toBe(true);
    expect(serialized).not.toHaveProperty('error');
    expect(parseBridgeResponse(serialized, 'corr-2', 'token-2', 'apply_ops')).toEqual(response);
  });
  it('acr_bridge_response_error_round_trip', () => {
    const response: AcrBridgeResponse = { correlationId: 'corr-3', bridgeToken: 'token-3', ok: false, error: 'WORKBENCH_UNAVAILABLE' };
    const serialized = JSON.parse(JSON.stringify(response));
    expect(serialized.error).toBe('WORKBENCH_UNAVAILABLE');
    expect(parseBridgeResponse(serialized, 'corr-3', 'token-3', 'probe')).toEqual(response);
  });
  it('acr_progress_round_trip', () => {
    const progress: AcrProgress = { correlationId: 'corr-4', bridgeToken: 'token-4', step: 2, total: 5, message: '正在添加节点', entityId: 'node-1' };
    const serialized = JSON.parse(JSON.stringify(progress));
    expect(serialized.correlationId).toBe('corr-4');
    expect(serialized.entityId).toBe('node-1');
    expect(serialized).toEqual(progress);
  });
  it('timeout_clamp_bounds', () => {
    expect(clampBridgeTimeout(1)).toBe(1000);
    expect(clampBridgeTimeout(999999)).toBe(300000);
    expect(clampBridgeTimeout(30000)).toBe(30000);
  });
  it('apply_ops_timeout_formula', () => {
    expect(applyOpsTimeoutMs(0, 'normal')).toBe(30000);
    expect(applyOpsTimeoutMs(10, 'normal')).toBe(33000);
    expect(applyOpsTimeoutMs(10, 'fast')).toBe(30500);
    expect(applyOpsTimeoutMs(200, 'demo')).toBe(120000);
    expect(applyOpsTimeoutMs(10000, 'normal')).toBe(120000);
  });
  it('uncertain_apply_receipt_requires_reread_and_disables_retry', () => {
    const receipt = uncertainApplyReceipt(['note-1'], ['追加正文'], 'ACR bridge timed out');
    expect(receipt.status).toBe('partial');
    expect(receipt.mode).toBe('frontend');
    expect(receipt.applied).toBeNull();
    expect(receipt.totalOps).toBe(1);
    expect(receipt.unknownOps).toEqual(['追加正文']);
    expect(receipt.resultUnknown).toBe(true);
    expect(receipt.retryable).toBe(false);
    expect(receipt.message).toContain('重新读取');
  });
  it('apply_receipt_validation_rejects_missing_or_forged_success', () => {
    expect(isValidApplyReceipt({ status: 'completed', mode: 'frontend', applied: 1, totalOps: 1, entityIds: ['node-1'], done: ['添加节点'], undone: [] })).toBe(true);
    expect(isValidApplyReceipt({ status: 'completed', mode: 'frontend' })).toBe(false);
    expect(isValidApplyReceipt({ status: 'completed', mode: 'frontend', applied: 0, totalOps: 10, entityIds: [], done: [], undone: ['forged'] })).toBe(false);
    expect(isValidApplyReceipt(null)).toBe(false);
  });
  it('session_scoped_run_id_preserves_tool_call_without_cross_session_collision', () => {
    const a = sessionScopedRunId('sess-a', 'call-1');
    expect(a).not.toBe(sessionScopedRunId('sess-b', 'call-1'));
    expect(a.endsWith(':call-1')).toBe(true);
    expect(a).toBe('acr3:6:sess-a:call-1');
  });
  it('bridge_response_requires_exact_identity_and_ok_data_contract', () => {
    const valid = { correlationId: 'corr-x', bridgeToken: 'token-x', ok: true, data: { windowId: 'win-1', created: true } };
    expect(() => parseBridgeResponse(valid, 'corr-x', 'token-x', 'open_app')).not.toThrow();
    expect(() => parseBridgeResponse(valid, 'corr-other', 'token-x', 'open_app')).toThrow();
    expect(() => parseBridgeResponse(valid, 'corr-x', 'wrong-token', 'open_app')).toThrow();
    expect(() => parseBridgeResponse({ correlationId: 'corr-x', bridgeToken: 'token-x', ok: true }, 'corr-x', 'token-x', 'open_app')).toThrow();
  });
  it('app_command_receipt_requires_domain_ack_or_structured_rejection', () => {
    expect(isValidCommandData('app_command', { handled: true, acknowledged: true })).toBe(true);
    expect(isValidCommandData('app_command', { handled: true })).toBe(false);
    expect(isValidCommandData('app_command', { handled: true, acknowledged: false })).toBe(false);
    expect(isValidCommandData('app_command', { handled: false, code: 'ACTION_UNAVAILABLE', hint: '目标 surface 未确认动作' })).toBe(true);
    expect(isValidCommandData('app_command', { handled: false })).toBe(false);
  });
  it('apply_receipt_validation_enforces_semantic_invariants', () => {
    expect(isValidApplyReceipt({ status: 'completed', mode: 'suggestion', applied: 0, totalOps: 1, entityIds: ['note-1'], done: ['已提交建议'], undone: [], suggestionPending: true })).toBe(true);
    expect(isValidApplyReceipt({ status: 'completed', mode: 'suggestion', applied: 0, totalOps: 1, entityIds: ['note-1'], done: [], undone: [] })).toBe(false);
    expect(isValidApplyReceipt({ status: 'failed', mode: 'suggestion', applied: 0, totalOps: 1, entityIds: ['note-1'], done: [], undone: ['建议面板正忙'] })).toBe(true);
    expect(isValidApplyReceipt({ status: 'completed', mode: 'frontend', applied: 2, totalOps: 1, entityIds: ['note-1'], done: ['one', 'two'], undone: [] })).toBe(false);
    expect(isValidApplyReceipt({ status: 'partial', mode: 'frontend', applied: 0, totalOps: 1, entityIds: [42], done: [], undone: ['待执行'] })).toBe(false);
  });
  it('is_bridge_cancelled_detects_prefix', () => {
    expect(isBridgeCancelled('CANCELLED: ACR bridge cancelled (corr=x)')).toBe(true);
    expect(isBridgeCancelled('cancelled')).toBe(true);
    expect(isBridgeCancelled('ACR bridge timed out after 3000ms')).toBe(false);
    expect(isBridgeCancelled('RESULT_UNKNOWN: ACR cancellation had no terminal receipt')).toBe(false);
    expect(isBridgeResultUnknown('RESULT_UNKNOWN: ACR cancellation had no terminal receipt')).toBe(true);
  });
  it('parent_select_dropping_bridge_future_runs_cancel_guard', async () => {
    // TS analogue of `select!` dropping the future: abort the parent token.
    const bus = fakeBus();
    const controller = new AbortController();
    const pending = acrBridgeCall(callContext(bus, controller.signal), 'probe', {}, 5_000);
    expect(bus.emitted.some(entry => entry.event === ACR_BRIDGE_REQUEST)).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow(/^CANCELLED: /);
    const cancels = bus.emitted.filter(entry => entry.event === ACR_BRIDGE_CANCEL);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.payload).toMatchObject({
      correlationId: 'uuid-1', bridgeToken: 'uuid-2', runId: 'acr3:8:sess-xyz:run-abc',
      toolCallId: 'run-abc', sessionId: 'sess-xyz',
    });
    expect(bus.listenerCount()).toBe(0);
  });
  it('parent_timeout_dropping_bridge_future_runs_cancel_guard', async () => {
    // The timeout race loses to the cancellation signal and still emits cancel once.
    const bus = fakeBus();
    const controller = new AbortController();
    const pending = acrBridgeCall(callContext(bus, controller.signal), 'probe', {}, 5_000);
    const raced = await Promise.race([
      pending.then(() => 'response', () => 'settled'),
      new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 0)),
    ]);
    expect(raced).toBe('timeout');
    controller.abort();
    await expect(pending).rejects.toThrow(/^CANCELLED: /);
    expect(bus.emitted.filter(entry => entry.event === ACR_BRIDGE_CANCEL)).toHaveLength(1);
  });
  it('terminal_bridge_response_disarms_cancel_guard', async () => {
    const bus = fakeBus();
    const unlisten = bus.listen(ACR_BRIDGE_REQUEST, () => {
      queueMicrotask(() => respond(bus, {
        correlationId: 'uuid-1', bridgeToken: 'uuid-2', ok: true,
        data: { revision: 'r1', windowId: 'win-1', typeId: 'note' },
      }));
    });
    await expect(acrBridgeCall(callContext(bus), 'observe', {}, 5_000)).resolves.toMatchObject({ ok: true });
    unlisten();
    expect(bus.emitted.filter(entry => entry.event === ACR_BRIDGE_CANCEL)).toHaveLength(0);
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('workbench_bridge.rs::acr_bridge_call', () => {
  it('acr_bridge_call_emits_session_scoped_request_with_clamped_timeout', async () => {
    const bus = fakeBus();
    const unlisten = bus.listen(ACR_BRIDGE_REQUEST, () => {
      queueMicrotask(() => respond(bus, {
        correlationId: 'uuid-1', bridgeToken: 'uuid-2', ok: true,
        data: { state: 'clean', windowId: null },
      }));
    });
    await acrBridgeCall(callContext(bus), 'probe', { windowId: 'w1' }, 999_999);
    unlisten();
    const request = bus.emitted.find(entry => entry.event === ACR_BRIDGE_REQUEST)!.payload as AcrBridgeRequest;
    expect(request).toEqual({
      correlationId: 'uuid-1', bridgeToken: 'uuid-2', command: 'probe', args: { windowId: 'w1' },
      timeoutMs: 300_000, runId: 'acr3:8:sess-xyz:run-abc', toolCallId: 'run-abc', sessionId: 'sess-xyz',
    });
  });

  it('acr_bridge_call_requires_non_empty_session_and_tool_call', async () => {
    const bus = fakeBus();
    await expect(acrBridgeCall({ ...callContext(bus), sessionId: '  ' }, 'probe', {}, 3_000))
      .rejects.toThrow('ACR bridge protocol error: non-empty sessionId and toolCallId are required');
    await expect(acrBridgeCall({ ...callContext(bus), toolCallId: '' }, 'probe', {}, 3_000))
      .rejects.toThrow('ACR bridge protocol error: non-empty sessionId and toolCallId are required');
    expect(bus.emitted).toHaveLength(0);
  });

  it('acr_bridge_call_forwards_progress_chunks_and_ignores_foreign_identity', async () => {
    const bus = fakeBus();
    const chunks: string[] = [];
    const warnings: string[] = [];
    const unlisten = bus.listen(ACR_BRIDGE_REQUEST, () => {
      bus.fire('acr:bridge-progress:uuid-1', {
        correlationId: 'uuid-1', bridgeToken: 'uuid-2', step: 1, message: '正在添加节点',
      });
      bus.fire('acr:bridge-progress:uuid-1', {
        correlationId: 'uuid-1', bridgeToken: 'wrong', step: 2, message: '伪造',
      });
      queueMicrotask(() => respond(bus, {
        correlationId: 'uuid-1', bridgeToken: 'uuid-2', ok: true,
        data: { state: 'clean', windowId: 'w1' },
      }));
    });
    await acrBridgeCall({
      ...callContext(bus), emitProgressChunk: chunk => chunks.push(chunk),
      logger: { warn: message => warnings.push(message) },
    }, 'probe', {}, 3_000);
    unlisten();
    expect(chunks).toEqual(['正在添加节点\n']);
    expect(warnings.some(message => message.includes('ignored progress with invalid bridge identity'))).toBe(true);
  });

  it('acr_bridge_call_ignores_response_with_wrong_bridge_token', async () => {
    const bus = fakeBus();
    const warnings: string[] = [];
    const unlisten = bus.listen(ACR_BRIDGE_REQUEST, () => {
      bus.fire('acr:bridge-response:uuid-1', {
        correlationId: 'uuid-1', bridgeToken: 'wrong', ok: true, data: { state: 'clean', windowId: null },
      });
      queueMicrotask(() => respond(bus, {
        correlationId: 'uuid-1', bridgeToken: 'uuid-2', ok: true,
        data: { state: 'clean', windowId: null },
      }));
    });
    await expect(acrBridgeCall({
      ...callContext(bus), logger: { warn: message => warnings.push(message) },
    }, 'probe', {}, 3_000)).resolves.toMatchObject({ ok: true });
    unlisten();
    expect(warnings.some(message => message.includes('ignored response with invalid bridge identity'))).toBe(true);
  });

  it('acr_bridge_call_cancel_drain_accepts_late_terminal_receipt', async () => {
    const bus = fakeBus();
    const controller = new AbortController();
    const unlisten = bus.listen(ACR_BRIDGE_REQUEST, () => {
      controller.abort();
      setTimeout(() => respond(bus, {
        correlationId: 'uuid-1', bridgeToken: 'uuid-2', ok: true,
        data: { state: 'clean', windowId: null },
      }), 5);
    });
    await expect(acrBridgeCall({
      ...callContext(bus, controller.signal), drainMs: 200,
    }, 'probe', {}, 3_000)).resolves.toMatchObject({ ok: true });
    unlisten();
    expect(bus.emitted.filter(entry => entry.event === ACR_BRIDGE_CANCEL)).toHaveLength(1);
  });

  it('acr_bridge_call_timeout_without_receipt_reports_result_unknown', async () => {
    const bus = fakeBus();
    const errors: string[] = [];
    await expect(acrBridgeCall({
      ...callContext(bus), drainMs: 10, logger: { warn: message => errors.push(message) },
    }, 'probe', {}, 1)).rejects.toThrow(
      'RESULT_UNKNOWN: ACR bridge timed out after 1000ms and no terminal receipt arrived during 10ms cancel drain (corr=uuid-1)',
    );
    expect(bus.emitted.filter(entry => entry.event === ACR_BRIDGE_CANCEL)).toHaveLength(1);
    expect(errors.some(message => message.includes('timed out after 1000ms'))).toBe(true);
  });

  it('acr_bridge_call_malformed_mutating_receipt_becomes_result_unknown', async () => {
    const bus = fakeBus();
    const unlisten = bus.listen(ACR_BRIDGE_REQUEST, () => {
      queueMicrotask(() => respond(bus, {
        correlationId: 'uuid-1', bridgeToken: 'uuid-2', ok: true, data: { status: 'completed' },
      }));
    });
    await expect(acrBridgeCall(callContext(bus), 'act', {}, 3_000))
      .rejects.toThrow(/^RESULT_UNKNOWN: ACR bridge protocol error: malformed act receipt/);
    unlisten();
  });
});
