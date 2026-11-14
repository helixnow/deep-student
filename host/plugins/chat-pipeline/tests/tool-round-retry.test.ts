import { describe, expect, it } from 'vitest';
import { ToolRounds, type ToolExecutionPorts } from '../src/tool-round.ts';
import type { ChatV2Emitter, ToolCall } from '../../chat/api.ts';

describe('ToolRounds transient retry event metadata', () => {
  it('tags retry attempt metadata on emitStart when retrying a transient read-only failure', async () => {
    const startedPayloads: unknown[] = [];
    let attempt = 0;
    const ports: ToolExecutionPorts = {
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      concurrencyClass: () => 'read_only',
      vfsFileExists: () => null,
      persistTodoList: () => {},
      resolveToolAuthoringConfig: async () => null,
      finalizeTaskCompletion: () => {},
      onTaskFinalized: () => {},
      saveIntermediateResultsWithRetry: async () => false,
      buildRetrievalPageImageInjection: () => null,
      resolveActiveApiConfig: async () => null,
      gate: {
        killSwitchError: () => null,
        executionPolicyAllows: () => true,
        trustedAutomationError: () => null,
        trustedAutomationPreauthorized: () => false,
        isLocalShell: () => false,
        isExternalMcp: () => false,
        immutableGuard: () => null,
        shellCommandDecision: () => null,
        resolveLocalShellApprovalArguments: () => ({ ok: true, value: null }),
        runtimeRootBinding: () => null,
        runtimeScopeKey: () => '',
        baseSensitivity: () => 'low',
        effectiveSensitivity: () => 'low',
        authorityState: () => ({ authorityMode: 'craft', permissionPreset: 'full_access', plan: null }) as never,
        consumePlanBinding: () => false,
        newPendingPlan: () => ({}) as never,
        setPlanState: () => {},
        isPrivilegeEscalation: () => false,
        neverRememberApproval: () => false,
        redactForDisplay: (_name, args) => args,
        runtimeApprovalScope: () => ({}),
        approvalManager: null,
        planGates: {} as never,
      },
      execute: async (call: ToolCall, init) => {
        attempt++;
        init.emitter.emitStartWithMeta(
          'tool_call',
          init.messageId,
          init.blockId,
          { toolName: call.name, toolInput: call.arguments, toolCallId: call.id },
          init.variantId,
          init.skillStateVersion,
          init.roundId,
        );
        if (attempt === 1) {
          init.emitter.emitErrorWithMeta(
            'tool_call',
            init.blockId,
            'connection reset by peer',
            init.variantId,
            init.skillStateVersion,
            init.roundId,
          );
          return {
            toolCallId: call.id,
            blockId: init.blockId,
            toolName: call.name,
            input: call.arguments,
            output: null,
            success: false,
            error: 'connection reset by peer',
            durationMs: 1,
          };
        }
        init.emitter.emitEndWithMeta(
          'tool_call',
          init.blockId,
          { result: { ok: true }, durationMs: 2 },
          init.variantId,
          init.skillStateVersion,
          init.roundId,
        );
        return {
          toolCallId: call.id,
          blockId: init.blockId,
          toolName: call.name,
          input: call.arguments,
          output: { ok: true },
          success: true,
          durationMs: 2,
        };
      },
    };

    const emitter = {
      registerBlockEventMeta: () => {},
      emitStart: () => {},
      emitStartWithMeta: (_type: string, _msg: string, _blk: string | null, payload: unknown) => {
        startedPayloads.push(payload);
      },
      emitChunk: () => {},
      emitEnd: () => {},
      emitEndWithMeta: () => {},
      emitError: () => {},
      emitErrorWithMeta: () => {},
      emitToolCallPreparingStart: () => {},
      emitStreamReconnect: () => {},
      emitCompactionCompleted: () => {},
      emitCompactionFailed: () => {},
      emitSkillInjectionAudit: () => {},
    } as unknown as ChatV2Emitter;

    const rounds = new ToolRounds(ports);
    const results = await rounds.executeToolCalls(
      [{ id: 'call_r1', name: 'builtin-note_read', arguments: { id: 'n1' } }],
      emitter,
      { sessionId: 's1', messageId: 'm1', variantId: null, options: {} as never, cancellation: null },
      'round_0',
      null,
      new Map(),
    );

    expect(attempt).toBe(2);
    expect(results[0]).toMatchObject({ success: true, output: { ok: true, _auto_retry_attempts: 1 } });
    expect(startedPayloads).toHaveLength(2);
    expect(startedPayloads[0]).not.toHaveProperty('retry');
    expect(startedPayloads[1]).toMatchObject({ retry: true, retryAttempt: 1 });
  });
});
