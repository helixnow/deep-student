/**
 * R1 L07-01: the real PTC executor is registered by the production plugin and
 * every script `call()` is dispatched through the central admitted dispatcher.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import { starlark } from '../../../platform/native/starlark/index.ts';
import type { NativeStarlark, StarlarkEvaluateOptions, StarlarkJson } from '../../../platform/native/starlark/api.ts';
import plugin from '../index.ts';
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../chat/api.ts';
import { memorySettings, unavailableStorage } from './platform-stubs.ts';

function executionContext(
  onDispatch: (call: ToolCall, ctx: ExecutionContext) => void,
): ExecutionContext {
  let saved: ToolResultInfo | undefined;
  const context = {
    session_id: 'session-ptc',
    message_id: 'message-ptc',
    block_id: 'block-ptc',
    variant_id: null,
    skill_state_version: null,
    round_id: null,
    tool_call_id: 'run-ptc',
    emitter: {},
    services: {},
    canvas_note_id: null,
    tauri_window: null,
    chat_v2_db: null,
    skill_contents: null,
    skill_embedded_tools: null,
    skill_admission_errors: null,
    skill_package_roots: null,
    execution_allowed_tools: null,
    cancellation_token: new AbortController().signal,
    shell_guard_approved: true,
    shell_authority_admission: ['craft', 'full_access'],
    admitted_tool_dispatcher: {
      async dispatchWithAdmission(call: ToolCall, child: ExecutionContext): Promise<ToolResultInfo> {
        onDispatch(call, child);
        return {
          toolCallId: call.id,
          blockId: child.block_id,
          toolName: call.name,
          input: call.arguments,
          output: { echoed: (call.arguments as { query?: string }).query ?? null },
          success: true,
          durationMs: 1,
        };
      },
    },
    rag_top_k: null,
    rag_enable_reranking: null,
    memory_enabled: true,
    rag_enabled: true,
    web_search_enabled: true,
    hasFrontend: () => false,
    tryWindow: () => null,
    windowRef: () => { throw new Error('no window'); },
    runId: () => 'run-ptc',
    isCancelled: () => false,
    saveToolBlock: (result: ToolResultInfo) => { saved = result; },
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    emitToolProgress: () => undefined,
    emitToolProgressPayload: () => undefined,
  };
  void saved;
  return context as unknown as ExecutionContext;
}

describe('R1 L07-01 PTC production wiring', () => {
  const hosts: Array<Awaited<ReturnType<typeof createTestHost>>> = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.dispose();
  });

  it('apply registers the real PtcExecutor in agentTools', async () => {
    const host = await createTestHost({
      plugins: [pathsPlugin, plugin],
      provide: {
        settings: memorySettings(), storage: unavailableStorage(), nativeStarlark: starlark,
      },
    });
    hosts.push(host);
    const executors = host.ctx.agentTools.toolExecutors();
    const ptc = executors.find(executor => executor.name() === 'PtcExecutor');
    expect(ptc).toBeDefined();
    expect(ptc?.canHandle('ptc_run')).toBe(true);
    expect(ptc?.canHandle('builtin-ptc_run')).toBe(true);
    expect(ptc?.sensitivityLevel?.('ptc_run')).toBe('medium');
    expect(ptc?.concurrencyClass?.('ptc_run')).toBe('serial');
    expect(ptc?.resultCharBudget?.('ptc_run')).toBeNull();
  });

  it('script calls go through the central dispatcher with a derived child context', async () => {
    const host = await createTestHost({
      plugins: [pathsPlugin, plugin],
      provide: {
        settings: memorySettings(), storage: unavailableStorage(), nativeStarlark: starlark,
      },
    });
    hosts.push(host);
    const ptc = host.ctx.agentTools.toolExecutors().find(executor => executor.name() === 'PtcExecutor');
    expect(ptc?.execute).toBeTypeOf('function');
    const dispatched: Array<{ call: ToolCall; ctx: ExecutionContext }> = [];
    const context = executionContext((call, child) => dispatched.push({ call, ctx: child }));
    const script = `
res = call("builtin-rag_search", {"query": "central"})
{"ok": res["ok"], "echoed": res["output"]["echoed"]}
`;
    const result = await ptc!.execute!(
      { id: 'ptc-1', name: 'ptc_run', arguments: { script } },
      context,
    ) as ToolResultInfo;
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).result).toEqual({ ok: true, echoed: 'central' });
    expect(dispatched).toHaveLength(1);
    const [sub] = dispatched;
    expect(sub!.call.name).toBe('builtin-rag_search');
    expect(sub!.ctx.session_id).toBe('session-ptc');
    expect(sub!.ctx.block_id).toBe('block-ptc-ptc-0');
    expect(sub!.ctx.tool_call_id).toBe('run-ptc');
    expect(sub!.ctx.cancellation_token?.aborted).toBe(false);
    // Rust guard approval is bound to one top-level command, never inherited.
    expect(sub!.ctx.shell_guard_approved).toBe(false);
    expect(sub!.ctx.shell_authority_admission).toBeNull();
  });

  it('resolves nativeStarlark from Context on every execution so profile replacement applies', async () => {
    const calls: string[] = [];
    const profile = (label: string): NativeStarlark => ({
      async evaluate(script: string, options: StarlarkEvaluateOptions): Promise<StarlarkJson> {
        calls.push(label);
        return starlark.evaluate(script, options);
      },
    });
    const host = await createTestHost({
      plugins: [pathsPlugin, plugin],
      provide: {
        settings: memorySettings(), storage: unavailableStorage(),
        nativeStarlark: profile('before-replacement'),
      },
    });
    hosts.push(host);
    host.ctx.set('nativeStarlark', profile('after-replacement'));
    const ptc = host.ctx.agentTools.toolExecutors().find(executor => executor.name() === 'PtcExecutor');
    const context = executionContext(() => undefined);
    const result = await ptc!.execute!(
      { id: 'ptc-profile', name: 'ptc_run', arguments: { script: '{"profile": True}' } },
      context,
    ) as ToolResultInfo;
    expect(result.success).toBe(true);
    expect(calls).toEqual(['after-replacement']);
  });
});
