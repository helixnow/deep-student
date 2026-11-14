/** WP-026 owner-seam regressions, NOT complete production-send evidence.
 * Real L04 registry/context, L07 registration, L05 policy/ApprovalManager and L06 authorization.
 * Only unpublished authority/Plan/todo ports and the leaf executor are fixtures.
 * No provided chatToolRuntime and no replacement of registry.execute.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import agentSkills from '../../agent-skills/index.ts';
import { ChatV2Emitter, BackendEventsSink, type ChatExecutionContext, type ExecutionContext, type ToolExecutor } from '../../chat/api.ts';
import { createWebSearchToolRegistry } from '../../mcp/api.ts';
import { type AuthorityState, type ToolRuntimeAuthorityOwner, type ToolRuntimeTodoOwner } from '../api.ts';
import { ToolRounds, type ToolContextInit } from '../src/tool-round.ts';
import { createPipelineHost } from './chat-host.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
let rounds: ToolRounds;
let init: ToolContextInit;
let state: AuthorityState;
let leaf: ToolExecutor['execute'];
const contexts: ChatExecutionContext[] = [];
const window = { window: 'main', webview: 'main' } as const;
const unreachable = (): never => { throw new Error('unpublished owner operation is outside this binding regression'); };
const authority: ToolRuntimeAuthorityOwner = {
  getSessionAuthorityState: () => state,
  createPendingPlan: unreachable, setSessionPlanState: unreachable, consumeSessionPlanBinding: unreachable,
};
const todo: ToolRuntimeTodoOwner = { getTodoList: unreachable, persistTodoList: unreachable };

beforeAll(async () => {
  host = await createPipelineHost({ vfs: true, provide: {
    mcp: { registry: createWebSearchToolRegistry({ doSearch: unreachable }) },
  } });
  await host.install(agentSkills);
  host.ctx.chatSession.createSession({ id: 'wp026-binding', mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z' });
  host.ctx.chatSession.createMessage({ id: 'wp026-message', sessionId: 'wp026-binding', role: 'assistant',
    blockIds: [], timestamp: Date.parse('2026-11-06T00:00:00Z') });
  host.ctx.agentTools.registerToolExecutors([{
    name: () => 'WP026BindingProbe', canHandle: name => name.startsWith('builtin-wp026_') || name === 'builtin-local_shell_execute',
    sensitivityLevel: name => name === 'builtin-local_shell_execute' ? 'high' : 'low',
    concurrencyClass: () => 'read_only',
    execute: async (call, context) => {
      contexts.push(context as ChatExecutionContext);
      return leaf(call as Parameters<ToolExecutor['execute']>[0], context as ChatExecutionContext);
    },
  }]);
}, 60_000);
afterEach(() => { vi.restoreAllMocks(); host.ctx.chatState.killSwitch.reset(); });
afterAll(async () => { init?.emitter.dispose(); await host?.dispose(); });

function setup() {
  contexts.length = 0;
  state = { authorityMode: 'craft', permissionPreset: 'cautious', plan: null };
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  rounds = new ToolRounds({ ...runtime, log: host.ctx.logger,
    resolveToolAuthoringConfig: unreachable, finalizeTaskCompletion: unreachable, onTaskFinalized: unreachable,
    saveIntermediateResultsWithRetry: unreachable, buildRetrievalPageImageInjection: unreachable,
    resolveActiveApiConfig: unreachable });
  init?.emitter.dispose();
  const emitter = ChatV2Emitter.withSinkAndBatching(Object.assign(new BackendEventsSink(host.ctx.backendEvents),
    { window: () => window }), 'wp026-binding', false);
  init = { sessionId: 'wp026-binding', messageId: 'wp026-message', blockId: 'wp026-parent', emitter,
    toolCallId: 'call-parent', canvasNoteId: 'canvas-1', ragTopK: 7, ragEnableReranking: false,
    variantId: 'variant-1', skillStateVersion: 8, roundId: 'round-1', executionAllowedTools: null,
    skillPackageRoots: { skill: '/registered/skill' }, questionAuthoringConfig: null,
    shellGuardApproved: true, shellAuthorityAdmission: ['craft', 'danger_full_access'],
    memoryEnabled: false, ragEnabled: true, webSearchEnabled: false, skillContents: { skill: 'body' },
    skillEmbeddedTools: { skill: [] }, skillAdmissionErrors: { failed: 'not admitted' },
    cancellation: new AbortController().signal,
    dispatcher: (call, context) => rounds.executeSingleTool(call, context), admittedDispatcher: rounds.admittedDispatcher };
  leaf = async (call, context) => {
    const result = { toolCallId: call.id, blockId: context.block_id, toolName: call.name,
      input: call.arguments, output: { read: true }, success: true };
    context.emitToolCallStart(call.name, call.arguments, call.id);
    context.saveToolBlock(result);
    context.emitToolCallEnd(result.output);
    return result;
  };
  return runtime;
}

it('binds registered executors to the real context, preserving context fields and crash-save ownership', async () => {
  const runtime = setup();
  const result = await rounds.executeSingleTool({ id: 'call-parent', name: 'builtin-wp026_read', arguments: { text: '中文' } }, init);
  expect(result.success).toBe(true);
  expect(runtime.concurrencyClass('builtin-wp026_read')).toBe('read_only');
  expect(contexts).toHaveLength(1);
  const context = contexts[0]!;
  expect(context).toMatchObject({ session_id: init.sessionId, message_id: init.messageId, block_id: init.blockId,
    tool_call_id: 'call-parent', canvas_note_id: 'canvas-1', rag_top_k: 7, rag_enable_reranking: false,
    variant_id: 'variant-1', skill_state_version: 8, round_id: 'round-1', execution_allowed_tools: null,
    skill_package_roots: { skill: '/registered/skill' }, skill_contents: { skill: 'body' },
    skill_embedded_tools: { skill: [] }, skill_admission_errors: { failed: 'not admitted' },
    shell_guard_approved: false, shell_authority_admission: ['craft', 'cautious'],
    memory_enabled: false, rag_enabled: true, web_search_enabled: false });
  expect(context.admitted_tool_dispatcher).toBe(rounds.admittedDispatcher);
  expect(context.windowRef()).toBe(window);
  expect(context.chat_v2_db).toBe(host.ctx.chatSession.database);
  expect(context.main_db).toBe(host.ctx.storage.database('mistakes'));
  expect(context.vfs_db).toBe(host.ctx.vfs.database);
  expect(context.runId()).toBe('call-parent');
  expect(context.isCancelled()).toBe(false);
  expect(host.ctx.chatSession.getBlock(init.blockId)).toMatchObject({ toolName: 'builtin-wp026_read',
    toolInput: { text: '中文' }, toolOutput: { read: true }, status: 'success' });
});

it.each(['policy', 'kill-switch', 'cancel'] as const)('child re-enters central admission with its own context: %s', async kind => {
  setup();
  const signal = new AbortController();
  leaf = async (call, original) => {
    const parent = original as ChatExecutionContext;
    expect(parent.admitted_tool_dispatcher).toBe(rounds.admittedDispatcher);
    const child = parent.scopedWithCancellationToken(signal.signal);
    child.block_id = `child-${kind}`;
    child.round_id = 'child-round';
    child.skill_state_version = 19;
    child.shell_guard_approved = true;
    child.shell_authority_admission = ['craft', 'danger_full_access'];
    if (kind === 'policy') child.execution_allowed_tools = [];
    if (kind === 'kill-switch') host.ctx.chatState.killSwitch.trip('WP026');
    if (kind === 'cancel') signal.abort();
    return parent.admitted_tool_dispatcher!.dispatchWithAdmission({ id: 'call-child', name: 'builtin-wp026_write', arguments: {} }, child);
  };
  const result = await rounds.executeSingleTool({ id: 'call-parent', name: 'builtin-wp026_read', arguments: {} }, init);
  expect(contexts).toHaveLength(1); // child never reached registry's leaf executor
  expect(result).toMatchObject({ toolCallId: 'call-child', blockId: `child-${kind}`, success: false });
  expect(result.error).toContain(kind === 'policy' ? '当前运行时未允许调用工具' : kind === 'kill-switch' ? 'AgentKillSwitch tripped' : '流已取消');
  expect(host.events.filter(e => e.event === 'chat_v2_event_wp026-binding').map(e => e.payload))
    .toContainEqual(expect.objectContaining({ blockId: `child-${kind}`, roundId: 'child-round', skillStateVersion: 19, phase: 'error' }));
});

it('an admitted child keeps the same dispatcher and scoped cancellation while refreshing its approval evidence', async () => {
  setup();
  const childCancel = new AbortController();
  const executeLeaf = leaf;
  leaf = async (call, original) => {
    if (call.id === 'call-child') return executeLeaf(call, original);
    const parent = original as ChatExecutionContext;
    const child = parent.scopedWithCancellationToken(childCancel.signal);
    child.block_id = 'child-admitted';
    child.variant_id = 'child-variant';
    child.round_id = 'child-round';
    child.skill_state_version = 21;
    child.shell_guard_approved = true;
    child.shell_authority_admission = ['craft', 'danger_full_access'];
    return parent.admitted_tool_dispatcher!.dispatchWithAdmission({ id: 'call-child', name: 'builtin-wp026_read', arguments: {} }, child);
  };
  const result = await rounds.executeSingleTool({ id: 'call-parent', name: 'builtin-wp026_read', arguments: {} }, init);
  expect(result).toMatchObject({ toolCallId: 'call-child', blockId: 'child-admitted', success: true });
  expect(contexts).toHaveLength(2);
  const [parent, child] = contexts;
  expect(child!.admitted_tool_dispatcher).toBe(parent!.admitted_tool_dispatcher);
  expect(child!.admitted_tool_dispatcher).toBe(rounds.admittedDispatcher);
  expect(child).toMatchObject({ session_id: init.sessionId, message_id: init.messageId, block_id: 'child-admitted',
    tool_call_id: 'call-child', variant_id: 'child-variant', round_id: 'child-round', skill_state_version: 21,
    shell_guard_approved: false, shell_authority_admission: ['craft', 'cautious'],
    canvas_note_id: 'canvas-1', rag_top_k: 7, skill_contents: { skill: 'body' } });
  childCancel.abort();
  expect(child!.isCancelled()).toBe(true);
  expect(parent!.isCancelled()).toBe(false);
});

it('question authoring config reaches parent and admitted child contexts through the published ExecutionContext', async () => {
  setup();
  const config = { id: 'cfg-chat', name: 'Chat', model: 'deepseek-chat', providerType: 'deepseek', isMultimodal: false,
    maxOutputTokens: 4096, maxTokensLimit: null, contextWindow: 64000 } as unknown as NonNullable<ToolContextInit['questionAuthoringConfig']>;
  init.questionAuthoringConfig = config;
  const seen: [ExecutionContext['question_authoring_config'], ReturnType<ExecutionContext['questionAuthoringRoute']>][] = [];
  const executeLeaf = leaf;
  leaf = async (call, original) => {
    const context: ExecutionContext = original;
    seen.push([context.question_authoring_config, context.questionAuthoringRoute()]);
    if (call.id === 'call-child') return executeLeaf(call, original);
    const child = (original as ChatExecutionContext).scopedWithCancellationToken(original.cancellation_token!);
    child.block_id = 'child-authoring';
    return original.admitted_tool_dispatcher!.dispatchWithAdmission({ id: 'call-child', name: 'builtin-wp026_read', arguments: {} }, child);
  };
  const result = await rounds.executeSingleTool({ id: 'call-parent', name: 'builtin-wp026_read', arguments: {} }, init);
  expect(result).toMatchObject({ toolCallId: 'call-child', success: true });
  const route = { model_config_id: 'cfg-chat', name: 'Chat', model: 'deepseek-chat', provider_type: 'deepseek',
    is_multimodal: false, max_output_tokens: 4096, max_tokens_limit: null, context_window: 64000 };
  expect(seen).toEqual([[config, route], [config, route]]);
  expect(Object.keys(seen[0]![1]!)).toEqual(Object.keys(route));
});

it('inherited shell approval cannot bypass the real ApprovalManager for a child command', async () => {
  setup();
  init.skillPackageRoots = null;
  const approvals: string[] = [];
  const off = host.ctx.backendEvents.listenWindow(window, 'chat_v2_event_wp026-binding', raw => {
    const event = raw as { type: string; phase: string; payload?: { toolCallId: string; toolName: string } };
    if (event.type !== 'tool_approval_request' || event.phase !== 'start') return;
    approvals.push(event.payload!.toolCallId);
    host.ctx.agentApproval.respond({ sessionId: init.sessionId, toolCallId: event.payload!.toolCallId,
      toolName: event.payload!.toolName, approved: false, reason: 'child rejected', remember: false, rememberSession: false });
  });
  leaf = async (_call, original) => {
    const parent = original as ChatExecutionContext;
    const child = parent.scopedWithCancellationToken(parent.cancellation_token!);
    child.block_id = 'child-shell';
    child.shell_guard_approved = true;
    child.shell_authority_admission = ['craft', 'danger_full_access'];
    return parent.admitted_tool_dispatcher!.dispatchWithAdmission({ id: 'call-shell', name: 'builtin-local_shell_execute',
      arguments: { command: 'echo wp026', root_id: 'temp', cwd: '.' } }, child);
  };
  try {
    const result = await rounds.executeSingleTool({ id: 'call-parent', name: 'builtin-wp026_read', arguments: {} }, init);
    expect(result, JSON.stringify(result)).toMatchObject({ blockId: 'child-shell', success: false, error: '用户拒绝执行此工具。用户说明：child rejected' });
    expect(approvals).toEqual(['call-shell']);
    expect(contexts).toHaveLength(1);
    expect(host.ctx.agentApproval.pendingCount()).toBe(0);
  } finally { off(); }
});
