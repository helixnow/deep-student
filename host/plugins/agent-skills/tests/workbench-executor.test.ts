import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_TOOL_NAMES, WorkbenchToolExecutor, appCommandBusinessError,
  canDispatchUnderOffGate, injectApprovalRiskCeiling, isLegacyHighRiskCommand,
  isReadonlyWorkbenchTool, isWorkbenchAgentDelegationEnabled, isWorkbenchAgentEnabled,
  mapBridgeError, normalizeBridgeArgs, resolveWorkbenchGates,
  trustedApprovalRiskCeiling, workbenchResultUnknown,
} from '../src/tools/workbench-executor.ts';
import type { WorkbenchGateEnvironment, WorkbenchToolContext } from '../src/tools/workbench-executor.ts';

describe('workbench_executor.rs', () => {
  it('can_handle_workbench_tools', () => {
    const executor = new WorkbenchToolExecutor();
    expect(executor.canHandle('builtin-workbench_list_windows')).toBe(true);
    expect(executor.canHandle('workbench_list_windows')).toBe(true);
    expect(executor.canHandle('builtin-workbench_open_app')).toBe(true);
    expect(executor.canHandle('workbench_open_app')).toBe(true);
    expect(executor.canHandle('builtin-workbench_app_command')).toBe(true);
    expect(executor.canHandle('workbench_app_command')).toBe(true);
    expect(executor.canHandle('builtin-workbench_close_window')).toBe(true);
    expect(executor.canHandle('workbench_close_window')).toBe(true);
    expect(executor.canHandle('builtin-workbench_query_state')).toBe(true);
    expect(executor.canHandle('workbench_query_state')).toBe(true);
    expect(executor.canHandle('builtin-workbench_get_capabilities')).toBe(true);
    expect(executor.canHandle('workbench_get_capabilities')).toBe(true);
    expect(executor.canHandle('builtin-workbench_observe')).toBe(true);
    expect(executor.canHandle('workbench_observe')).toBe(true);
    expect(executor.canHandle('builtin-workbench_act')).toBe(true);
    expect(executor.canHandle('workbench_act')).toBe(true);
    expect(executor.canHandle('builtin-workbench_act_high')).toBe(true);
    expect(executor.canHandle('workbench_act_high')).toBe(true);
    expect(executor.canHandle('builtin-workbench_wait_for')).toBe(true);
    expect(executor.canHandle('workbench_wait_for')).toBe(true);
    expect(executor.canHandle('builtin-workbench_undo')).toBe(true);
    expect(executor.canHandle('workbench_undo')).toBe(true);
    expect(executor.canHandle('builtin-web_fetch')).toBe(false);
    expect(executor.canHandle('user_todo_list_lists')).toBe(false);
    expect(executor.canHandle('browser_open')).toBe(false);
  });

  it('sensitivity_matrix', () => {
    const executor = new WorkbenchToolExecutor();
    expect(executor.sensitivityLevel('builtin-workbench_close_window')).toBe('high');
    expect(executor.sensitivityLevel('workbench_app_command')).toBe('medium');
    expect(executor.sensitivityLevel('builtin-workbench_list_windows')).toBe('low');
    expect(executor.sensitivityLevel('workbench_open_app')).toBe('medium');
    expect(executor.sensitivityLevel('workbench_query_state')).toBe('low');
    expect(executor.sensitivityLevel('workbench_get_capabilities')).toBe('low');
    expect(executor.sensitivityLevel('workbench_observe')).toBe('low');
    expect(executor.sensitivityLevel('workbench_act')).toBe('medium');
    expect(executor.sensitivityLevel('workbench_act_high')).toBe('high');
    expect(executor.sensitivityLevel('workbench_wait_for')).toBe('low');
    expect(executor.sensitivityLevel('workbench_undo')).toBe('high');
    expect(executor.managesCancellation('workbench_act')).toBe(true);
  });

  it('normalize_promotes_snake_case', () => {
    const raw = {
      type_id: 'note',
      instance_key: 'res-1',
      window_id: 'win-9',
      observation_revision: 'rev-4',
      stop_on_failure: true,
      timeout_ms: 1200,
      interval_ms: 80,
      undo_token: 'acr-undo:token-1',
      action: 'focusNode',
    };
    const normalized = normalizeBridgeArgs(raw) as Record<string, unknown>;
    expect(normalized.typeId).toBe('note');
    expect(normalized.instanceKey).toBe('res-1');
    expect(normalized.windowId).toBe('win-9');
    expect(normalized.observationRevision).toBe('rev-4');
    expect(normalized.stopOnFailure).toBe(true);
    expect(normalized.timeoutMs).toBe(1200);
    expect(normalized.intervalMs).toBe(80);
    expect(normalized.undoToken).toBe('acr-undo:token-1');
    expect(normalized.action).toBe('focusNode');
    expect(normalized.type_id).toBeUndefined();
    expect(normalized.instance_key).toBeUndefined();
    expect(normalized.window_id).toBeUndefined();
  });

  it('normalize_keeps_camel_case_priority', () => {
    const normalized = normalizeBridgeArgs({
      typeId: 'todo', type_id: 'note', focus: true,
    }) as Record<string, unknown>;
    expect(normalized.typeId).toBe('todo');
    expect(normalized.type_id).toBeUndefined();
    expect(normalized.focus).toBe(true);
  });

  it('risk_ceiling_is_overwritten_by_trusted_tool_path', () => {
    const regular = injectApprovalRiskCeiling(normalizeBridgeArgs({
      observationRevision: 'rev-1',
      actions: [{ name: 'stop' }],
      approvalRiskCeiling: 'high',
    }), 'medium');
    expect(regular.approvalRiskCeiling).toBe('medium');

    const elevated = injectApprovalRiskCeiling(normalizeBridgeArgs({
      observationRevision: 'rev-1',
      actions: [{ name: 'stop' }],
      approvalRiskCeiling: 'read',
    }), 'high');
    expect(elevated.approvalRiskCeiling).toBe('high');

    expect(trustedApprovalRiskCeiling(WORKBENCH_TOOL_NAMES.ACT)).toBe('medium');
    expect(trustedApprovalRiskCeiling(WORKBENCH_TOOL_NAMES.ACT_HIGH)).toBe('high');
    expect(trustedApprovalRiskCeiling(WORKBENCH_TOOL_NAMES.UNDO)).toBe('high');
    expect(trustedApprovalRiskCeiling(WORKBENCH_TOOL_NAMES.OPEN_APP)).toBeUndefined();
  });

  it('legacy_high_risk_action_cannot_bypass_act_high', () => {
    expect(isLegacyHighRiskCommand({ typeId: 'pomodoro', action: 'stop' })).toBe(true);
    expect(isLegacyHighRiskCommand({ typeId: 'pomodoro', action: 'pause' })).toBe(false);
    expect(isLegacyHighRiskCommand({ typeId: 'sandbox', action: 'setMode' })).toBe(true);
    expect(isLegacyHighRiskCommand({ typeId: 'exam', action: 'nextQuestion' })).toBe(false);
  });

  it('gate_setting_parser', () => {
    expect(isWorkbenchAgentEnabled('')).toBe(true);
    expect(isWorkbenchAgentEnabled('off')).toBe(false);
    expect(isWorkbenchAgentEnabled('OFF')).toBe(false);
    expect(isWorkbenchAgentEnabled('true')).toBe(false);
    expect(isWorkbenchAgentEnabled('background')).toBe(true);
    expect(isWorkbenchAgentEnabled('Follow')).toBe(true);
  });

  it('readonly_tools_under_off_gate', () => {
    const names = WORKBENCH_TOOL_NAMES;
    expect(isReadonlyWorkbenchTool(names.GET_CAPABILITIES)).toBe(true);
    expect(isReadonlyWorkbenchTool(names.OBSERVE)).toBe(true);
    expect(isReadonlyWorkbenchTool(names.WAIT_FOR)).toBe(true);
    expect(isReadonlyWorkbenchTool(names.LIST_WINDOWS)).toBe(true);
    expect(isReadonlyWorkbenchTool(names.QUERY_STATE)).toBe(true);
    expect(isReadonlyWorkbenchTool(names.ACT)).toBe(false);
    expect(isReadonlyWorkbenchTool(names.ACT_HIGH)).toBe(false);
    expect(isReadonlyWorkbenchTool(names.UNDO)).toBe(false);
    expect(isReadonlyWorkbenchTool(names.OPEN_APP)).toBe(false);
    expect(isReadonlyWorkbenchTool(names.APP_COMMAND)).toBe(false);
    expect(isReadonlyWorkbenchTool(names.CLOSE_WINDOW)).toBe(false);

    expect(canDispatchUnderOffGate(names.ACT)).toBe(true);
    expect(canDispatchUnderOffGate(names.ACT_HIGH)).toBe(true);
    expect(canDispatchUnderOffGate(names.OBSERVE)).toBe(true);
    expect(canDispatchUnderOffGate(names.UNDO)).toBe(false);
    expect(canDispatchUnderOffGate(names.APP_COMMAND)).toBe(false);
  });

  it('map_bridge_error_preserves_known_codes', () => {
    const disabled = mapBridgeError('WORKBENCH_DISABLED: 桌面模式未开启');
    expect(disabled).toContain('WORKBENCH_DISABLED');
    expect(disabled).toContain('"retryable":false');

    const busy = mapBridgeError('WINDOW_BUSY');
    expect(busy).toContain('WINDOW_BUSY');
    expect(busy).toContain('"retryable":true');

    const stale = mapBridgeError('STALE_OBSERVATION: expected rev-1');
    expect(stale).toContain('STALE_OBSERVATION');
    expect(stale).toContain('重新 observe');

    const risk = mapBridgeError('RISK_APPROVAL_REQUIRED: sandbox.setMode');
    expect(risk).toContain('RISK_APPROVAL_REQUIRED');
    expect(risk).toContain('workbench_act_high');

    const unknown = workbenchResultUnknown('RESULT_UNKNOWN: cancel drain expired');
    expect(unknown).toContain('RESULT_UNKNOWN');
    expect(unknown).toContain('"retryable":false');
    expect(unknown).toContain('"resultUnknown":true');

    const exactWindow = JSON.parse(mapBridgeError(JSON.stringify({
      code: 'STALE_TARGET_WINDOW',
      message: 'window changed',
      hint: 'probe again',
      retryable: false,
    }))) as Record<string, unknown>;
    expect(exactWindow.code).toBe('STALE_TARGET_WINDOW');
    expect(exactWindow.message).toBe('window changed');
    expect(exactWindow.hint).toBe('probe again');
    expect(exactWindow.retryable).toBe(false);

    const undoProgress = JSON.parse(mapBridgeError(JSON.stringify({
      code: 'UNDO_IN_PROGRESS',
      message: 'already reverting',
      retryable: true,
    }))) as Record<string, unknown>;
    expect(undoProgress.code).toBe('UNDO_IN_PROGRESS');
    expect(undoProgress.retryable).toBe(true);
  });

  it('map_bridge_error_passes_through_attached_observation', () => {
    const raw = JSON.stringify({
      code: 'STALE_OBSERVATION',
      message: '观察已过期',
      hint: '直接基于附带 observation 重新规划',
      retryable: true,
      observation: { revision: 'acr:next', windowId: 'w1' },
    });
    const mapped = JSON.parse(mapBridgeError(raw)) as Record<string, unknown>;
    expect(mapped.code).toBe('STALE_OBSERVATION');
    expect(mapped.retryable).toBe(true);
    expect((mapped.observation as Record<string, unknown>).revision).toBe('acr:next');
    expect((mapped.observation as Record<string, unknown>).windowId).toBe('w1');
  });

  it('app_command_unhandled_maps_to_tool_error', () => {
    expect(appCommandBusinessError({ handled: true })).toBeUndefined();
    expect(appCommandBusinessError({})).toBeUndefined();

    const error = JSON.parse(appCommandBusinessError({
      handled: false,
      code: 'UNKNOWN_ACTION',
      hint: 'note 不支持指令 search',
    })!) as Record<string, unknown>;
    expect(error.code).toBe('UNKNOWN_ACTION');
    expect(error.hint).toBe('note 不支持指令 search');
    expect(error.retryable).toBe(false);

    const fallback = JSON.parse(appCommandBusinessError({ handled: false })!) as Record<
      string, unknown
    >;
    expect(fallback.code).toBe('ACTION_FAILED');
  });
});

// ------------------------------------------------------------------ production dispatch

interface RecordingBus {
  emitted: Array<{ event: string; payload: unknown }>;
  emit(event: string, payload: unknown): void;
  listen(event: string, handler: (payload: unknown) => void): () => void;
  fire(event: string, payload: unknown): void;
  listeners: Map<string, Set<(payload: unknown) => void>>;
}

function recordingBus(onRequest?: (request: Record<string, unknown>, bus: RecordingBus) => void): RecordingBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const bus: RecordingBus = {
    emitted: [], listeners,
    listen(event, handler) {
      let set = listeners.get(event);
      if (set === undefined) listeners.set(event, (set = new Set()));
      set.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    fire(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    emit(event, payload) {
      bus.emitted.push({ event, payload });
      if (event === 'acr:bridge-request') {
        onRequest?.(payload as Record<string, unknown>, bus);
      } else {
        bus.fire(event, payload);
      }
    },
  };
  return bus;
}

function gateEnv(flag: boolean, setting: string | null): WorkbenchGateEnvironment {
  return { featureFlagEnabled: () => flag, settings: { get: () => setting } };
}

function toolContext(bus: RecordingBus, gates: WorkbenchGateEnvironment, overrides: Partial<WorkbenchToolContext> = {}): WorkbenchToolContext {
  return {
    sessionId: 'sess-1', toolCallId: 'call-1', blockId: 'block-1',
    events: bus, gates, ...overrides,
  };
}

function reply(bus: RecordingBus, ok: boolean, payload: Record<string, unknown>): void {
  const request = bus.emitted.find(entry => entry.event === 'acr:bridge-request')!.payload as Record<string, unknown>;
  bus.fire(`acr:bridge-response:${String(request.correlationId)}`, {
    correlationId: request.correlationId, bridgeToken: request.bridgeToken, ok, ...payload,
  });
}

const OBSERVE_DATA = { revision: 'rev-1', windowId: 'win-1', typeId: 'note' };
const ACT_DATA = {
  status: 'completed', windowId: 'win-1', typeId: 'note', beforeRevision: 'rev-1',
  afterRevision: 'rev-2', results: [], verified: true, failedConditions: [], observation: {},
};

describe('workbench_executor.rs::dispatch', () => {
  it('resolve_workbench_gates_flag_off_setting_off_and_defaults', () => {
    expect(resolveWorkbenchGates(gateEnv(false, 'follow'))).toBe('flag_off');
    expect(resolveWorkbenchGates(gateEnv(true, 'off'))).toBe('off');
    expect(resolveWorkbenchGates(gateEnv(true, null))).toBe('enabled');
    expect(resolveWorkbenchGates(gateEnv(true, ''))).toBe('enabled');
    expect(resolveWorkbenchGates(gateEnv(true, ' Background '))).toBe('enabled');
    expect(resolveWorkbenchGates(gateEnv(true, 'off'))).toBe('off');
    expect(isWorkbenchAgentDelegationEnabled(gateEnv(true, 'follow'))).toBe(true);
    expect(isWorkbenchAgentDelegationEnabled(gateEnv(true, 'off'))).toBe(false);
  });

  it('resolve_workbench_gates_preserves_appstate_and_setting_errors', () => {
    expect(() => resolveWorkbenchGates(null)).toThrow(/"code":"WORKBENCH_UNAVAILABLE".*AppState 不可用/);
    expect(() => resolveWorkbenchGates({ featureFlagEnabled: () => { throw new Error('flag db gone'); }, settings: { get: () => null } }))
      .toThrow(/flag db gone/);
    expect(() => resolveWorkbenchGates({ featureFlagEnabled: () => true, settings: { get: () => { throw new Error('disk'); } } }))
      .toThrow(/读取设置失败: disk/);
  });

  it('dispatch_rejects_flag_off_and_off_gate_writes', async () => {
    const executor = new WorkbenchToolExecutor();
    const bus = recordingBus();
    await expect(executor.dispatch('workbench_list_windows', {}, toolContext(bus, gateEnv(false, 'follow'))))
      .rejects.toThrow(/"code":"WORKBENCH_DISABLED".*tools\.workbench_agent/);
    await expect(executor.dispatch('workbench_close_window', {}, toolContext(bus, gateEnv(true, 'off'))))
      .rejects.toThrow(/desktop\.workbenchAgentControl=off.*workbench_close_window/);
    expect(bus.emitted).toHaveLength(0);
  });

  it('dispatch_allows_readonly_tools_under_off_gate', async () => {
    const executor = new WorkbenchToolExecutor();
    const bus = recordingBus((_request, current) => {
      queueMicrotask(() => reply(current, true, { data: OBSERVE_DATA }));
    });
    await expect(executor.dispatch('workbench_observe', { window_id: 'win-1' }, toolContext(bus, gateEnv(true, 'off'))))
      .resolves.toEqual(OBSERVE_DATA);
  });

  it('dispatch_blocks_legacy_high_risk_app_command_before_bridge', async () => {
    const executor = new WorkbenchToolExecutor();
    const bus = recordingBus();
    await expect(executor.dispatch(
      'workbench_app_command',
      { type_id: 'sandbox', action: 'setMode' },
      toolContext(bus, gateEnv(true, 'follow')),
    )).rejects.toThrow(/"code":"RISK_APPROVAL_REQUIRED"/);
    expect(bus.emitted).toHaveLength(0);
  });

  it('dispatch_injects_trusted_approval_risk_ceiling', async () => {
    const executor = new WorkbenchToolExecutor();
    let seen: Record<string, unknown> | undefined;
    const bus = recordingBus((request, current) => {
      seen = request;
      queueMicrotask(() => reply(current, true, { data: ACT_DATA }));
    });
    await expect(executor.dispatch(
      'workbench_act',
      { observation_revision: 'rev-1', approvalRiskCeiling: 'high' },
      toolContext(bus, gateEnv(true, 'follow')),
    )).resolves.toEqual(ACT_DATA);
    expect(seen?.command).toBe('act');
    expect(seen?.timeoutMs).toBe(15_000);
    expect((seen?.args as Record<string, unknown>).observationRevision).toBe('rev-1');
    expect((seen?.args as Record<string, unknown>).approvalRiskCeiling).toBe('medium');
  });

  it('RF-W02-workbench-untrusted-risk-ceiling: tools without a trusted ceiling never forward the model-supplied one', async () => {
    const executor = new WorkbenchToolExecutor();
    let seen: Record<string, unknown> | undefined;
    const bus = recordingBus((request, current) => {
      seen = request;
      queueMicrotask(() => reply(current, true, { data: OBSERVE_DATA }));
    });
    await executor.dispatch('workbench_observe',
      { window_id: 'win-1', approvalRiskCeiling: 'high', approval_risk_ceiling: 'high' },
      toolContext(bus, gateEnv(true, 'follow')));
    expect(seen?.args).toEqual({ windowId: 'win-1' });
  });

  it('dispatch_maps_bridge_ok_false_errors', async () => {
    const executor = new WorkbenchToolExecutor();
    const bus = recordingBus((_request, current) => {
      queueMicrotask(() => reply(current, false, { error: JSON.stringify({ code: 'WINDOW_BUSY', message: 'busy' }) }));
    });
    const error = await executor.dispatch('workbench_observe', {}, toolContext(bus, gateEnv(true, 'follow')))
      .catch((caught: unknown) => caught as Error);
    const parsed = JSON.parse((error as Error).message) as Record<string, unknown>;
    expect(parsed.code).toBe('WINDOW_BUSY');
    expect(parsed.retryable).toBe(true);
  });

  it('dispatch_maps_cancellation_to_structured_cancelled', async () => {
    const executor = new WorkbenchToolExecutor();
    const bus = recordingBus();
    const controller = new AbortController();
    const pending = executor.dispatch('workbench_observe', {}, toolContext(bus, gateEnv(true, 'follow'), { cancel: controller.signal, drainMs: 20 }));
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught as Error);
    expect(JSON.parse((error as Error).message).code).toBe('CANCELLED');
  });

  it('execute_emits_events_and_persists_success_and_failure_results', async () => {
    const executor = new WorkbenchToolExecutor();
    const events: string[] = [];
    const saved: unknown[] = [];
    const bus = recordingBus((_request, current) => {
      queueMicrotask(() => reply(current, true, { data: OBSERVE_DATA }));
    });
    const ok = await executor.execute(
      { id: 'call-1', name: 'builtin-workbench_observe', arguments: {} },
      toolContext(bus, gateEnv(true, 'follow'), {
        emitToolCallStart: name => events.push(`start:${name}`),
        emitToolCallEnd: () => events.push('end'),
        emitToolCallError: error => events.push(`error:${error}`),
        saveToolBlock: result => saved.push(result),
      }),
    );
    expect(ok).toMatchObject({ toolCallId: 'call-1', blockId: 'block-1', success: true, output: OBSERVE_DATA });
    expect(events).toEqual(['start:builtin-workbench_observe', 'end']);

    events.length = 0;
    const failed = await executor.execute(
      { id: 'call-2', name: 'builtin-workbench_observe', arguments: {} },
      toolContext(bus, gateEnv(false, 'follow'), {
        emitToolCallStart: name => events.push(`start:${name}`),
        emitToolCallEnd: () => events.push('end'),
        emitToolCallError: () => events.push('error'),
        saveToolBlock: result => saved.push(result),
      }),
    );
    expect(failed).toMatchObject({ toolCallId: 'call-2', success: false, output: null });
    expect((failed as { error: string }).error).toContain('WORKBENCH_DISABLED');
    expect(events).toEqual(['start:builtin-workbench_observe', 'error']);
    expect(saved).toHaveLength(2);
  });
});
