/** Native JSON.rawJSON atoms in tool arguments (Value::Number spelled `1.0`) through the W02 tool path:
 * adapter → reverse name mapping → approval gate → real registry/executor → block store → PipelineContext →
 * model-bound history. Only the authority/todo ports and the leaf executor are fixtures.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import agentSkills from '../../agent-skills/index.ts';
import { ChatV2Emitter, BackendEventsSink, type ChatExecutionContext, type ToolExecutor } from '../../chat/api.ts';
import { createWebSearchToolRegistry } from '../../mcp/api.ts';
import type { AuthorityState, JsonValue, ToolRuntimeAuthorityOwner, ToolRuntimeTodoOwner } from '../api.ts';
import { historyMessage } from '../src/history-replay.ts';
import { ChatV2StreamingAdapter } from '../src/llm-adapter.ts';
import { PipelineContext } from '../src/pipeline-context.ts';
import { bindStreamingSink } from '../src/stream-sink.ts';
import { ToolRounds, scopeOf } from '../src/tool-round.ts';
import { messageForModel2 } from '../src/unified-text-stream.ts';
import { createPipelineHost } from './chat-host.ts';

const rawJSON = (text: string) => (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(text);
const SESSION = 'atom-session';
const MESSAGE = 'atom-message';
const window = { window: 'main', webview: 'main' } as const;
const unreachable = (): never => { throw new Error('unpublished owner operation is outside this regression'); };
const state: AuthorityState = { authorityMode: 'craft', permissionPreset: 'cautious', plan: null };
const authority: ToolRuntimeAuthorityOwner = {
  getSessionAuthorityState: () => state,
  createPendingPlan: unreachable, setSessionPlanState: unreachable, consumeSessionPlanBinding: unreachable,
};
const todo: ToolRuntimeTodoOwner = { getTodoList: unreachable, persistTodoList: unreachable };

let host: Awaited<ReturnType<typeof createPipelineHost>>;
let emitter: ChatV2Emitter;
let fail = false;
const seen: unknown[] = [];

beforeAll(async () => {
  host = await createPipelineHost({ vfs: true, provide: {
    mcp: { registry: createWebSearchToolRegistry({ doSearch: unreachable }) },
  } });
  await host.install(agentSkills);
  host.ctx.chatSession.createSession({ id: SESSION, mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
  host.ctx.chatSession.createMessage({ id: MESSAGE, sessionId: SESSION, role: 'assistant',
    blockIds: [], timestamp: Date.parse('2026-11-07T00:00:00Z') });
  host.ctx.agentTools.registerToolExecutors([{
    name: () => 'AtomProbe', canHandle: name => name.startsWith('builtin-atom_'),
    sensitivityLevel: name => name === 'builtin-atom_write' ? 'high' : 'low',
    concurrencyClass: () => 'read_only',
    execute: (async (call, context: ChatExecutionContext) => {
      seen.push(call.arguments);
      if (fail) throw new Error('probe failed');
      const args = call.arguments as Record<string, unknown>;
      const result = { toolCallId: call.id, blockId: context.block_id, toolName: call.name,
        input: call.arguments, output: { limit: args.limit, ratio: rawJSON('2.50') }, success: true };
      context.saveToolBlock(result);
      return result;
    }) as ToolExecutor['execute'],
  }]);
  emitter = ChatV2Emitter.withSinkAndBatching(Object.assign(new BackendEventsSink(host.ctx.backendEvents),
    { window: () => window }), SESSION, false);
}, 60_000);
afterAll(async () => { emitter?.dispose(); await host?.dispose(); });

async function runRound(toolName: string) {
  seen.length = 0;
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  const rounds = new ToolRounds({ ...runtime, log: host.ctx.logger,
    resolveToolAuthoringConfig: unreachable, finalizeTaskCompletion: unreachable, onTaskFinalized: unreachable,
    saveIntermediateResultsWithRetry: unreachable, buildRetrievalPageImageInjection: unreachable,
    resolveActiveApiConfig: unreachable });
  const adapter = new ChatV2StreamingAdapter(bindStreamingSink(emitter), MESSAGE, { enableThinking: false });
  adapter.onToolCall({ ...historyMessage('assistant', ''),
    tool_call: { id: `call-${toolName}`, tool_name: `mcp_${toolName}`, args_json: { limit: rawJSON('1.0'), text: '中文' } } });
  const ctx = new PipelineContext({ sessionId: SESSION, content: 'atoms', assistantMessageId: MESSAGE });
  const mapping = new Map([[`mcp_${toolName}`, { rawToolName: `builtin-${toolName}`, preferredServerId: 'srv-1' }]]);
  const calls = adapter.takeToolCalls().map(call => ({ id: call.id, name: call.name, arguments: call.arguments as JsonValue }));
  const results = await rounds.executeToolCalls(calls, emitter, scopeOf(ctx), 'round-atom', null, mapping);
  for (const result of results) ctx.addToolBlock(result, MESSAGE);
  ctx.addToolResults(results);
  return { ctx, results };
}

const ARGS = '{"limit":1.0,"text":"中文","_serverId":"srv-1"}';

it('a raw atom reaches the executor, the stored block and the next model request with its spelling intact', async () => {
  fail = false;
  const { ctx, results } = await runRound('atom_read');
  expect(results).toHaveLength(1);
  expect(results[0], JSON.stringify(results[0])).toMatchObject({ success: true, toolName: 'builtin-atom_read' });
  expect(seen.map(args => JSON.stringify(args))).toEqual([ARGS]);

  const blockId = results[0]!.blockId!;
  const row = host.ctx.chatSession.database.getConnSafe().get<{ tool_input_json: string; tool_output_json: string }>(
    'SELECT tool_input_json, tool_output_json FROM chat_v2_blocks WHERE id = ?1', [blockId]);
  expect(row).toEqual({ tool_input_json: ARGS, tool_output_json: '{"limit":1.0,"ratio":2.50}' });

  const block = ctx.interleavedBlocks.find(value => value.id === blockId);
  expect(JSON.stringify(block?.toolInput)).toBe(ARGS);
  const request = JSON.stringify(ctx.allToolResultsToMessages().map(messageForModel2));
  expect(request).toContain(`"args_json":${ARGS}`);
  expect(request).toContain('"data_json":{"limit":1.0,"ratio":2.50}');
});

it('approval-scoped tools fingerprint and redact atom arguments without throwing', async () => {
  fail = false;
  const approvals: string[] = [];
  const off = host.ctx.backendEvents.listenWindow(window, `chat_v2_event_${SESSION}`, raw => {
    const event = raw as { type: string; phase: string; payload?: { toolCallId: string; toolName: string } };
    if (event.type !== 'tool_approval_request' || event.phase !== 'start') return;
    approvals.push(event.payload!.toolCallId);
    host.ctx.agentApproval.respond({ sessionId: SESSION, toolCallId: event.payload!.toolCallId,
      toolName: event.payload!.toolName, approved: true, reason: null, remember: false, rememberSession: false });
  });
  try {
    const { results } = await runRound('atom_write');
    expect(results[0], JSON.stringify(results[0])).toMatchObject({ success: true, toolName: 'builtin-atom_write' });
    expect(approvals).toEqual(['call-atom_write']);
    expect(seen.map(args => JSON.stringify(args))).toEqual([ARGS]);
  } finally { off(); }
});

it('a failing executor still reports and replays the atom arguments unchanged', async () => {
  fail = true;
  const { ctx, results } = await runRound('atom_read');
  expect(results[0]).toMatchObject({ success: false });
  expect(results[0]!.error).toContain('probe failed');
  expect(JSON.stringify(results[0]!.input)).toBe(ARGS);
  expect(JSON.stringify(ctx.allToolResultsToMessages().map(messageForModel2))).toContain(`"args_json":${ARGS}`);
});
