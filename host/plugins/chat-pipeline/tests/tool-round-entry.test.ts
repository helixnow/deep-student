/** tool_loop.rs:1823–3585 + hooks.rs gate through host.ctx.chatPipeline.execute.
 * Real L02 streaming/tool-call parsing over HTTP/SSE; the owner tool runtime (`chatToolRuntime`) and the
 * L04 repository surface are owner-port fixtures. All L03 ordering, gating, retry and persistence run for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import { historyStorePort } from './history-store-port.ts';
import { PlanGateManager } from '../src/authority-mode.ts';
import type { AuthorityState, ChatToolRuntime, JsonValue, ToolFacePrefixSnapshot, ToolSensitivity } from '../api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const requests: Record<string, unknown>[] = [];
let responses: ((response: ServerResponse) => void)[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
  responses.shift()!(response);
});
const sse = (...events: unknown[]) => (response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
};
const usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 };
const toolCallTurn = (name: string, args: string) => sse(
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_echo_1', type: 'function', function: { name, arguments: args } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage });
const answerTurn = (text: string) => sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage });

let authority: AuthorityState = { authorityMode: 'craft', permissionPreset: 'full_access', plan: null };
let sensitivity: ToolSensitivity = 'low';
const executed: { name: string; args: JsonValue; shellGuardApproved: boolean }[] = [];
const runtime: ChatToolRuntime = {
  concurrencyClass: () => 'read_only',
  execute: vi.fn(async (call, init) => {
    executed.push({ name: call.name, args: call.arguments, shellGuardApproved: init.shellGuardApproved });
    init.emitter.emitStartWithMeta('tool_call', init.messageId, init.blockId,
      { toolName: call.name, toolInput: call.arguments, toolCallId: call.id }, init.variantId, init.skillStateVersion, init.roundId);
    const output = { echoed: (call.arguments as { text?: string }).text ?? null };
    init.emitter.emitEndWithMeta('tool_call', init.blockId, output, init.variantId, init.skillStateVersion, init.roundId);
    return { toolCallId: call.id, blockId: init.blockId, toolName: call.name, input: call.arguments, output, success: true };
  }),
  vfsFileExists: () => null,
  persistTodoList: () => {},
  gate: {
    killSwitchError: () => null, executionPolicyAllows: () => true,
    trustedAutomationError: () => null, trustedAutomationPreauthorized: () => false,
    isLocalShell: () => false, isExternalMcp: () => false, immutableGuard: () => null, shellCommandDecision: () => null,
    resolveLocalShellApprovalArguments: () => ({ ok: true, value: null }), runtimeRootBinding: () => null,
    runtimeScopeKey: name => name, baseSensitivity: () => sensitivity, effectiveSensitivity: base => base,
    authorityState: () => authority, consumePlanBinding: () => true,
    newPendingPlan: () => ({ planId: 'plan_fixture', markApproved() {} }), setPlanState: () => {},
    isPrivilegeEscalation: () => false, neverRememberApproval: () => false, redactForDisplay: (_name, args) => args,
    runtimeApprovalScope: () => null, approvalManager: null, planGates: new PlanGateManager(),
  },
};

const prefixes = new Map<string, ToolFacePrefixSnapshot>();
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createPipelineHost({ llm: true, provide: { chatToolRuntime: runtime } });
  await host.ctx.llm.saveApiConfigurations([{ id: 'tool-config', name: 'tool test', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'tool-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  const persistence = persistenceStorePort();
  const service = host.ctx.chatSession;
  Object.assign(service, persistence, historyStorePort(service, persistence), {
    getMessageWithConn: (_conn: unknown, id: string) => service.getMessage(id),
    updateMessageWithConn: (conn: { run(sql: string, params: unknown[]): void }, message: { id: string; blockIds: string[]; _meta?: unknown }) => {
      conn.run('UPDATE chat_v2_messages SET block_ids_json=?, meta_json=? WHERE id=?',
        [JSON.stringify(message.blockIds), JSON.stringify(message._meta ?? null), message.id]);
    },
    getToolFacePrefix: (sessionId: string) => prefixes.get(sessionId) ?? null,
    advanceToolFacePrefix: (sessionId: string, snapshot: ToolFacePrefixSnapshot) => { prefixes.set(sessionId, structuredClone(snapshot)); },
  });
}, 60_000);
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

const echoTool = { name: 'builtin-echo_text', description: 'Echo text back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
let sequence = 0;
function turn() {
  const sessionId = `tool_round_${++sequence}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  const events: { eventType?: string; type?: string; phase?: string; error?: string }[] = [];
  host.ctx.backendEvents.listen(`chat_v2_session_${sessionId}`, value => { events.push(value as typeof events[number]); });
  host.ctx.backendEvents.listen(`chat_v2_event_${sessionId}`, value => { events.push(value as typeof events[number]); });
  const assistantId = `msg_tool_assistant_${sequence}`;
  const apiName = host.ctx.chatPipeline.prepareExternalToolSchema(echoTool, true)!.apiName;
  return { sessionId, assistantId, events, apiName, run: () => host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' },
    { sessionId, content: 'please echo', userMessageId: `msg_tool_user_${sequence}`, assistantMessageId: assistantId,
      options: { modelId: 'tool-config', enableThinking: false, memoryEnabled: false, webSearchEnabled: false,
        mcpToolSchemas: [echoTool] } }, new AbortController().signal, null) };
}

/** Checkpoint B (tool_loop.rs:2337) always estimates tool output tokens with the native tokenizer.
 * The repository install lacks the `tiktoken` package (infra-owned, see BLOCKERS.md); these cases run
 * wherever the production tokenizer dependency is present (verified with NODE_PATH pointing at it).
 */
const hasTokenizer = (() => { try { createRequire(import.meta.url)('tiktoken'); return true; } catch { return false; } })();

describe.skipIf(!hasTokenizer)('tool round: provider tool call → L03 gate → owner executor → second round → final save', () => {
  it('executes an admitted low-sensitivity tool and feeds the result into the next provider request', async () => {
    authority = { authorityMode: 'craft', permissionPreset: 'full_access', plan: null }; sensitivity = 'low';
    const t = turn(); requests.length = 0; executed.length = 0;
    responses = [toolCallTurn(t.apiName, '{"text":"hello"}'), answerTurn('final after tool')];
    expect(await t.run()).toBe(t.assistantId);
    expect(requests).toHaveLength(2);
    expect((requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)).toContain(t.apiName);
    expect(executed).toEqual([{ name: 'builtin-echo_text', args: { text: 'hello' }, shellGuardApproved: false }]);
    const second = requests[1]!.messages as { role: string; content: unknown; tool_call_id?: string }[];
    const toolMessage = second.find(message => message.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe('call_echo_1');
    expect(String(toolMessage?.content)).toContain('hello');
    const blocks = host.ctx.chatSession.getMessageBlocks(t.assistantId);
    expect(blocks.map(block => block.type)).toEqual(['mcp_tool', 'content']);
    expect(blocks[0]).toMatchObject({ status: 'success', toolName: 'builtin-echo_text', toolOutput: { echoed: 'hello' } });
    expect(blocks[1]!.content).toBe('final after tool');
    expect(t.events.filter(e => e.eventType).map(e => e.eventType)).toEqual(['stream_start', 'stream_complete']);
  });

  it('Ask mode blocks a medium-sensitivity write before the executor and returns the structured refusal', async () => {
    authority = { authorityMode: 'ask', permissionPreset: 'cautious', plan: null }; sensitivity = 'medium';
    const t = turn(); requests.length = 0; executed.length = 0;
    responses = [toolCallTurn(t.apiName, '{"text":"write"}'), answerTurn('cannot do that in ask mode')];
    await t.run();
    expect(executed).toEqual([]);
    const blocks = host.ctx.chatSession.getMessageBlocks(t.assistantId);
    expect(blocks[0]).toMatchObject({ status: 'error', toolName: 'builtin-echo_text',
      toolOutput: { authorityBlocked: true, authorityMode: 'ask', suggestedMode: 'plan', toolName: 'builtin-echo_text' } });
    expect(blocks[0]!.error).toMatch(/^AUTHORITY_BLOCKED: session is in Ask/);
    const errors = t.events.filter(e => e.type === 'tool_call' && e.phase === 'error');
    expect(errors).toHaveLength(1);
    expect(blocks.at(-1)!.content).toBe('cannot do that in ask mode');
  });

  it('empty arguments for a schema with required fields are not executed (tool_loop.rs:1891)', async () => {
    authority = { authorityMode: 'craft', permissionPreset: 'full_access', plan: null }; sensitivity = 'low';
    const t = turn(); requests.length = 0; executed.length = 0;
    responses = [toolCallTurn(t.apiName, '{}'), answerTurn('retrying later')];
    await t.run();
    expect(executed).toEqual([]);
    const block = host.ctx.chatSession.getMessageBlocks(t.assistantId)[0]!;
    expect(block.status).toBe('error');
    expect(block.error).toContain('returned empty arguments but requires: text');
  });
});
