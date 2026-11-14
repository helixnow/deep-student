import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';
import { ChatV2Emitter, getToolTimeoutSecs, getExecutorTimeoutSecs, registryCancelledError, registryTimeoutError } from '../api.ts';
import type { ToolExecutor, ToolResultInfo, ToolExecutorRegistry } from '../api.ts';
import { BUILTIN_DESCRIPTORS } from '../../agent-orchestration/api.ts';
import { TRUNCATION_MARKER, serializedCharLen, type AgentJson } from '../../../kernel/api.ts';

function executor(name: string, names: string[]): ToolExecutor {
  return { name: () => name, canHandle: tool => names.includes(tool), async execute(call) {
    return { toolCallId: call.id, blockId: 'test_block', toolName: call.name, input: call.arguments,
      output: { executed_by: name }, success: true, durationMs: 10 };
  } };
}

describe('tools/executor_registry.rs through provided chatSession factory', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let registry: ToolExecutorRegistry;
  beforeAll(async () => { host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub } }); });
  afterAll(async () => { await host.dispose(); });
  beforeEach(() => {
    registry = host.ctx.chatSession.createExecutorRegistry([], {
      // L05 owns these policies; the registry must only forward the concrete call.
      ignoresBroadApprovalBypassForArgs: name => ['builtin-workspace_file_delete', 'builtin-qbank_delete_questions'].includes(name),
      neverRememberApprovalForArgs: name => name === 'builtin-qbank_delete_questions',
    });
  });
  afterEach(() => { vi.useRealTimers(); });
  function context() {
    return host.ctx.chatSession.createExecutionContext({ sessionId: 'sess_registry', messageId: 'msg_registry', blockId: 'blk_registry',
      services: host.ctx, emitter: ChatV2Emitter.newHeadless('sess_registry'), blockTypeForTool: () => 'mcp_tool',
      toolRegistry: { async detectToolConflicts() { return []; }, stripMcpNamespace: name => name,
        async callTool() { throw new Error('MCP dispatch is not exercised by this registry fixture'); } } });
  }
  it('test_registry_creation', () => { expect(registry.isEmpty()).toBe(true); expect(registry.len()).toBe(0); });
  it('test_register_executor', () => {
    registry.register(executor('test', ['tool_a'])); expect(registry.len()).toBe(1);
    expect(registry.canHandle('tool_a')).toBe(true); expect(registry.canHandle('tool_b')).toBe(false);
  });
  it('test_executor_priority', () => {
    registry.register(executor('executor1', ['tool_a'])); registry.register(executor('executor2', ['tool_a']));
    expect(registry.getExecutor('tool_a')?.name()).toBe('executor1');
  });
  it('test_get_sensitivity', () => {
    registry.register(executor('test', ['tool_a']));
    expect(registry.getSensitivity('tool_a')).toBe('low'); expect(registry.getSensitivity('unknown_tool')).toBeNull();
    expect(registry.getSensitivityForCall('tool_a', { action: 'get' })).toBe('low');
    expect(registry.getSensitivityForCall('unknown_tool', {})).toBeNull();
  });
  it('test_tool_sensitivity_default', () => {
    registry.register(executor('defaults', ['plain']));
    expect(registry.getSensitivity('plain')).toBe('low');
  });
  it('test_tool_concurrency_default_is_serial', () => {
    registry.register(executor('defaults', ['plain']));
    expect(registry.getConcurrencyClass('plain')).toBe('serial');
  });
  it('risk_snapshot_uses_concrete_call_ssot_and_exposes_policy_guards', () => {
    registry.register({ ...executor('dynamic-test', ['dynamic_tool']), sensitivityLevel: () => 'medium',
      sensitivityLevelForCall: (_name, args) => (args as { destructive?: boolean }).destructive === true ? 'high' : 'medium',
      hasDynamicSensitivity: () => true });
    registry.register(executor('protected-test', ['builtin-workspace_file_delete', 'builtin-qbank_delete_questions']));
    expect(registry.describeRiskForCall('dynamic_tool', { destructive: true })).toMatchObject({ baseSensitivity: 'high', dynamic: true, protected: false, neverRemember: false });
    expect(registry.describeRiskForCall('builtin-workspace_file_delete', { path: 'a.txt' })).toMatchObject({ protected: true, neverRemember: false });
    expect(registry.describeRiskForCall('builtin-qbank_delete_questions', { question_ids: ['q-1'] })).toMatchObject({ protected: true, neverRemember: true });
    expect(registry.describeRiskForCall('unknown_tool', {})).toBeNull();
  });
  it('test_get_concurrency_class_defaults_to_serial', () => {
    registry.register(executor('test', ['tool_a']));
    expect(registry.getConcurrencyClass('tool_a')).toBe('serial'); expect(registry.getConcurrencyClass('unknown_tool')).toBe('serial');
    expect(registry.managesCancellation('tool_a')).toBe(false);
  });
  it('image_generation_tool_uses_five_minute_timeout', () => {
    expect(getToolTimeoutSecs('builtin-image_generate')).toBe(300); expect(getToolTimeoutSecs('image_generate')).toBe(300);
  });
  it('external_mcp_namespaces_use_three_minute_timeout', () => {
    expect(getToolTimeoutSecs('mcp_brave_search')).toBe(180); expect(getToolTimeoutSecs('mcp.tools.brave_search')).toBe(180);
  });
  it('ask_user_tool_is_not_subject_to_global_timeout', () => {
    expect(getToolTimeoutSecs('builtin-ask_user')).toBe(0); expect(getToolTimeoutSecs('ask_user')).toBe(0);
  });
  it('ask_user_is_no_timeout_tool_for_pack_validation', () => {
    expect(registry.isNoTimeoutTool('builtin-ask_user')).toBe(true); expect(registry.isNoTimeoutTool('ask_user')).toBe(true);
    expect(registry.isNoTimeoutTool('builtin-template_validate')).toBe(false); expect(registry.isNoTimeoutTool('builtin-tool_pack')).toBe(false);
  });
  it('tool_pack_uses_ten_minute_timeout', () => {
    expect(getToolTimeoutSecs('builtin-tool_pack')).toBe(600); expect(getToolTimeoutSecs('tool_pack')).toBe(600);
  });
  it('index_rebuild_and_webpage_save_use_dedicated_long_timeouts', () => {
    expect(getToolTimeoutSecs('builtin-index_rebuild')).toBe(600); expect(getToolTimeoutSecs('index_rebuild')).toBe(600);
    expect(getToolTimeoutSecs('builtin-webpage_save')).toBe(300); expect(getToolTimeoutSecs('webpage_save')).toBe(300);
    expect(getToolTimeoutSecs('builtin-index_status')).toBe(120);
  });
  it('registry_errors_are_structured_and_keep_retry_keywords', () => {
    const cancelled = JSON.parse(registryCancelledError('builtin-web_fetch'));
    expect(cancelled.code).toBe('TOOL_CANCELLED'); expect(cancelled.retryable).toBe(false);
    expect(cancelled.messageFallback['zh-CN']).toContain('已取消'); expect(cancelled.message.toLowerCase()).toContain('cancel');
    const timed = JSON.parse(registryTimeoutError('builtin-web_fetch', 180));
    expect(timed.code).toBe('TOOL_TIMEOUT'); expect(timed.retryable).toBe(true);
    expect(timed.messageParams.timeoutSecs).toBe(180); expect(timed.message.toLowerCase()).toContain('timed out');
  });
  it('translation_uses_ten_minute_timeout', () => {
    expect(getToolTimeoutSecs('builtin-translate_text')).toBe(600); expect(getToolTimeoutSecs('translate_text')).toBe(600);
    expect(getToolTimeoutSecs('builtin-translation_save')).toBe(120);
  });
  it('local_shell_registry_watchdog_is_disabled_for_authoritative_cleanup', () => { expect(getToolTimeoutSecs('builtin-local_shell_execute')).toBe(0); });
  it('blocking_collaboration_tools_are_exempt_from_registry_watchdog', () => {
    for (const name of ['subagent_call', 'coordinator_sleep']) for (const prefix of ['', 'builtin-']) {
      expect(getToolTimeoutSecs(prefix + name)).toBe(0); expect(registry.isNoTimeoutTool(prefix + name)).toBe(true);
    }
  });
  it('acr_capable_executors_outlive_the_full_bridge_transaction_budget', () => {
    expect(getExecutorTimeoutSecs('builtin-note_update', 'CanvasToolExecutor')).toBe(180);
    expect(getExecutorTimeoutSecs('builtin-resource_update', 'BuiltinResourceExecutor')).toBe(180);
    expect(getExecutorTimeoutSecs('builtin-workbench_app_command', 'WorkbenchToolExecutor')).toBe(180);
    expect(getExecutorTimeoutSecs('builtin-template_validate', 'TemplateExecutor')).toBe(120);
  });
  it('timeout_migration_matches_legacy_mapping_for_every_tool', () => {
    function legacy(name: string): number {
      const bare = name.startsWith('builtin-') ? name.slice(8) : name;
      if (['ask_user', 'subagent_call', 'super_dispatch_worker', 'super_message_worker', 'coordinator_sleep', 'local_shell_execute'].includes(bare)) return 0;
      if (['paper_save', 'translate_text', 'index_rebuild', 'tool_pack', 'qbank_generate_questions', 'ptc_run'].includes(bare)) return 600;
      // Host-only plugin workshop builds: multi-round generate/compile needs the long watchdog.
      if (['dstu_plugin_propose_install', 'dstu_plugin_validate'].includes(bare)) return 600;
      if (['web_search', 'arxiv_search', 'scholar_search', 'web_fetch', 'rag_search', 'multimodal_search', 'unified_search'].includes(bare)) return 180;
      // Host-only network probes: same watchdog as the legacy web-search family.
      if (['llm_config_models_fetch', 'llm_config_test', 'dstu_config_search_test'].includes(bare)) return 180;
      if (bare === 'cite_format') return 30;
      if (['webpage_save', 'docx_create', 'pptx_create', 'xlsx_create', 'docx_to_spec', 'pptx_to_spec', 'xlsx_to_spec', 'docx_replace_text', 'pptx_replace_text', 'xlsx_replace_text'].includes(bare)) return 300;
      if (bare === 'chatanki_wait') return 3660;
      if (bare.startsWith('chatanki_')) return 600;
      if (bare === 'image_generate') return 300;
      if (bare.startsWith('workbench_') || bare.startsWith('mcp_') || bare.startsWith('mcp.tools.')) return 180;
      return 120;
    }
    for (const descriptor of BUILTIN_DESCRIPTORS) for (const name of [descriptor.name, `builtin-${descriptor.name}`]) {
      expect(getToolTimeoutSecs(name), name).toBe(legacy(name));
    }
    for (const name of ['mcp_brave_search', 'mcp.tools.brave_search', 'builtin-mcp_unknown_tool', 'totally_unknown_tool', 'builtin-totally_unknown_tool', 'builtin-builtin-web_search']) expect(getToolTimeoutSecs(name), name).toBe(legacy(name));
    expect(getToolTimeoutSecs('builtin-chatanki_x')).toBe(120); expect(getToolTimeoutSecs('builtin-workbench_x')).toBe(120);
  });
  it('external MCP routing bypasses builtin matches but retains backend MCP management executors', () => {
    const specific = executor('McpManageExecutor', ['mcp_server_remove', 'mcp_remote']);
    const general = executor('GeneralToolExecutor', []);
    registry.register(specific); registry.register(general);
    expect(registry.getExecutor('mcp_remote')).toBe(general);
    expect(registry.getExecutor('mcp_server_remove')).toBe(specific);
    expect(registry.hasSpecificExecutor('mcp_remote')).toBe(false);
    expect(registry.executorNames()).toEqual(['McpManageExecutor', 'GeneralToolExecutor']);
  });
  it('cancellation aborts the scoped child before the registry rejects', async () => {
    let signal: AbortSignal | null = null;
    registry.register({ ...executor('waiting', ['wait']), execute(_call, ctx) {
      signal = ctx.cancellation_token; return new Promise(() => {});
    } });
    const ctx = context(); const parent = new AbortController(); ctx.cancellation_token = parent.signal;
    const operation = registry.execute({ id: 'call', name: 'wait', arguments: {} }, ctx);
    const rejected = expect(operation).rejects.toThrow('TOOL_CANCELLED'); parent.abort(); await rejected;
    expect(signal!.aborted).toBe(true);
  });
  it('timeouts distinguish normal tools from self-managed terminal-unknown execution', async () => {
    vi.useFakeTimers();
    for (const selfManaged of [false, true]) {
      let signal: AbortSignal | null = null;
      const name = selfManaged ? 'managed' : 'normal';
      registry.register({ ...executor(name, [name]), managesCancellation: () => selfManaged,
        execute(_call, ctx) { signal = ctx.cancellation_token; return new Promise(() => {}); } });
      const operation = registry.execute({ id: 'call', name, arguments: {} }, context());
      const rejected = expect(operation).rejects.toThrow(selfManaged ? 'RESULT_UNKNOWN:' : 'TOOL_TIMEOUT');
      await vi.advanceTimersByTimeAsync(120_000); await rejected; expect(signal!.aborted).toBe(true);
    }
  });
  it('self-managed no-timeout tools observe cancellation but are allowed to return their terminal receipt', async () => {
    let resolve!: (value: ToolResultInfo) => void;
    registry.register({ ...executor('managed', ['local_shell_execute']), managesCancellation: () => true,
      execute() { return new Promise(done => { resolve = done; }); } });
    const ctx = context(); const parent = new AbortController(); ctx.cancellation_token = parent.signal;
    let settled = false;
    const operation = registry.execute({ id: 'c', name: 'local_shell_execute', arguments: {} }, ctx).finally(() => { settled = true; });
    parent.abort(); await Promise.resolve(); expect(settled).toBe(false);
    resolve({ toolName: 'local_shell_execute', input: {}, output: { receipt: 'cancelled' }, success: false });
    expect((await operation).output).toEqual({ receipt: 'cancelled' });
  });
  async function budget(output: AgentJson, requested?: number | null): Promise<AgentJson> {
    const name = `budget_${registry.len()}`;
    registry.register({ ...executor('budget', [name]), ...(requested === undefined ? {} : { resultCharBudget: () => requested }),
      async execute() { return { toolName: 'budget', input: {}, output, success: true }; } });
    return (await registry.execute({ id: 'call', name, arguments: {} }, context())).output as AgentJson;
  }
  it('result_budget_is_noop_within_budget', async () => {
    const output = { id: 'abc', content: 'short' }; expect(await budget(output, 30_000)).toEqual(output);
  });
  it('result_budget_shrinks_long_string_leaves_but_keeps_structure', async () => {
    const output = await budget({ file_id: 'file_123', success: true, content: 'x'.repeat(50_000) }, 2048) as Record<string, AgentJson>;
    expect(output.file_id).toBe('file_123'); expect(output.success).toBe(true); expect(output.truncated).toBe(true);
    expect(output.original_chars).toBeGreaterThan(2048); expect((output.content as string).endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(serializedCharLen(output)).toBeLessThan(50_000);
  });
  it('result_budget_falls_back_to_preview_for_huge_arrays', async () => {
    const output = Array.from({ length: 20_000 }, (_, i) => ({ i })); const original = serializedCharLen(output);
    expect(await budget(output, 2048)).toMatchObject({ truncated: true, original_chars: original, preview: expect.any(String) });
  });
  it('result_budget_enforces_minimum_budget', async () => {
    const output = await budget({ content: 'y'.repeat(10_000) }, 0);
    expect(output).toMatchObject({ truncated: true }); expect(serializedCharLen(output)).toBeGreaterThanOrEqual(256);
  });
  it('default budget and explicit null retain separate meanings', async () => {
    const output = { content: 'x'.repeat(50_000) };
    expect(await budget(output)).toMatchObject({ truncated: true });
    expect(await budget(output, null)).toEqual(output);
  });
});
