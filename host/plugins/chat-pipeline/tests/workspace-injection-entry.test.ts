/** WP-061: real execute → L05 injector/coordinator → L02/L01 HTTP requests + L04 persistence.
 * Only remote HTTP and the unrelated tool-executor owner port are scripted.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { InjectionThrottle, WorkspaceInjector, MAX_INJECTED_MESSAGE_CHARS } from '../../agent-workspace/api.ts';
import type { ChatToolRuntime, PipelineSendRequest } from '../api.ts';
import { PlanGateManager } from '../src/authority-mode.ts';
import { createPipelineHost } from './chat-host.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const requests: { messages: { role: string; content: unknown; tool_call_id?: string }[] }[] = [];
let responses: ((response: ServerResponse) => void)[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  const next = responses.shift();
  if (next) next(response);
  else { response.writeHead(400); response.end('unexpected provider request'); }
});
const sse = (...events: unknown[]) => (response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
};
const usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 };
const answer = (text: string) => sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage });
const tool = (id: string, args = '{"text":"echo"}') => sse({ choices: [{ delta: { tool_calls: [{ index: 0,
  id, type: 'function', function: { name: 'builtin-echo_text', arguments: args } }] }, finish_reason: 'tool_calls' }], usage });
const window = { window: 'main', webview: 'main' } as const;
let toolEffect = () => {};
let completed = false;
const runtime: ChatToolRuntime = {
  concurrencyClass: () => 'read_only',
  execute: async (call, init) => {
    toolEffect();
    return { toolCallId: call.id, blockId: init.blockId, toolName: call.name, input: call.arguments,
      output: completed ? { task_completed: true } : { echoed: 'echo' }, success: true };
  },
  vfsFileExists: () => null, persistTodoList: () => {},
  gate: {
    killSwitchError: () => null, executionPolicyAllows: () => true,
    trustedAutomationError: () => null, trustedAutomationPreauthorized: () => false,
    isLocalShell: () => false, isExternalMcp: () => false, immutableGuard: () => null, shellCommandDecision: () => null,
    resolveLocalShellApprovalArguments: () => ({ ok: true, value: null }), runtimeRootBinding: () => null,
    runtimeScopeKey: name => name, baseSensitivity: () => 'low', effectiveSensitivity: base => base,
    authorityState: () => ({ authorityMode: 'craft', permissionPreset: 'full_access', plan: null }), consumePlanBinding: () => true,
    newPendingPlan: () => ({ planId: 'plan_fixture', markApproved() {} }), setPlanState: () => {},
    isPrivilegeEscalation: () => false, neverRememberApproval: () => false, redactForDisplay: (_name, args) => args,
    runtimeApprovalScope: () => null, approvalManager: null, planGates: new PlanGateManager(),
  },
};

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createPipelineHost({ llm: true, diagnostics: true, provide: { chatToolRuntime: runtime } });
  await host.ctx.llm.saveApiConfigurations([{ id: 'workspace-config', name: 'workspace test', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'workspace-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
    enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
}, 60_000);
afterEach(() => { vi.restoreAllMocks(); toolEffect = () => {}; completed = false; });
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

let sequence = 0;
function turn() {
  const sessionId = `injection_${++sequence}`, worker = `worker_${sequence}`, assistantId = `msg_${sessionId}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });
  const workspace = host.ctx.agentWorkspace.createWorkspace(sessionId, 'WP-061');
  host.ctx.agentWorkspace.registerAgent(workspace.id, sessionId, 'coordinator', null, null);
  host.ctx.agentWorkspace.registerAgent(workspace.id, worker, 'worker', null, null);
  requests.length = 0; host.events.length = 0;
  const cancel = new AbortController();
  const request: PipelineSendRequest = { sessionId, content: 'current user', userMessageId: `user_${sessionId}`,
    assistantMessageId: assistantId, workspaceId: workspace.id,
    options: { modelId: 'workspace-config', enableThinking: false, memoryEnabled: false, ragEnabled: false,
      webSearchEnabled: false, autoMemoryExtraction: false, skillStateVersion: 7,
      mcpToolSchemas: [{ name: 'builtin-echo_text', description: 'Echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } };
  return { sessionId, worker, assistantId, workspaceId: workspace.id, request, cancel,
    run: () => host.ctx.chatPipeline.execute(window, request, cancel.signal, null),
    send: (content: string) => host.ctx.agentWorkspace.sendMessage(workspace.id, worker, sessionId, 'result', content),
    peek: () => host.ctx.agentWorkspace.peekInbox(workspace.id, sessionId),
    blocks: () => host.ctx.chatSession.getMessageBlocks(assistantId),
    events: () => host.events.filter(e => e.event === `chat_v2_event_${sessionId}`)
      .map(e => e.payload as { type: string; phase: string; blockId: string; payload?: unknown; roundId?: string; skillStateVersion?: number }),
    terminals: () => host.events.filter(e => e.event === `chat_v2_session_${sessionId}`)
      .map(e => (e.payload as { eventType: string }).eventType),
  };
}
const injected = (index: number) => requests[index]!.messages.filter(m => String(m.content).startsWith('[工作区消息]'));

it.each([false, true])('idle injection consumes inbox, precedes current user and preserves Rust pre-save order (assistant exists=%s)', async existing => {
  const t = turn(); t.send('短消息内容'); t.send('长'.repeat(MAX_INJECTED_MESSAGE_CHARS + 100));
  if (existing) host.ctx.chatSession.createMessage({ id: t.assistantId, sessionId: t.sessionId,
    role: 'assistant', blockIds: [], timestamp: Date.now() });
  expect(t.peek()).toHaveLength(2); expect(t.peek()).toHaveLength(2);
  const atStart: unknown[] = [];
  const off = host.ctx.backendEvents.listenWindow(window, `chat_v2_event_${t.sessionId}`, raw => {
    const e = raw as { type: string; phase: string; blockId: string };
    if (e.type === 'workspace_injection' && e.phase === 'start') atStart.push({
      block: host.ctx.chatSession.getBlock(e.blockId), ids: host.ctx.chatSession.getMessage(t.assistantId)?.blockIds,
    });
  });
  responses = [answer('first answer'), answer('after workspace')];
  try { expect(await t.run()).toBe(t.assistantId); } finally { off(); }
  expect(requests).toHaveLength(2); expect(injected(0)).toEqual([]);
  const content = `[工作区消息]\n来自 ${t.worker}: [result] 短消息内容\n来自 ${t.worker}: [result] ${'长'.repeat(4000)}…[truncated]\n`;
  // L02 merges adjacent user messages (model2_pipeline.rs:5818); assert the full HTTP bytes.
  const current = requests[0]!.messages.find(m => m.role === 'user')!.content;
  expect(injected(1)).toEqual([{ role: 'user', content: `${content}\n\n${current}` }]);
  const second = requests[1]!.messages;
  expect(String(second.find(m => m.role === 'user')!.content).indexOf(content))
    .toBeLessThan(String(second.find(m => m.role === 'user')!.content).indexOf('current user'));
  expect(t.peek()).toEqual([]);
  expect(host.ctx.agentWorkspace.pendingInboxCount(t.workspaceId, t.sessionId)).toBe(0);
  const block = t.blocks().find(b => b.type === 'workspace_injection')!;
  expect(block).toMatchObject({ status: 'success', content, toolOutput: { workspace_id: t.workspaceId,
    message_count: 2, senders: [t.worker], message_types: ['result', 'result'] } });
  expect((block.toolOutput as { injected_at: string }).injected_at).toMatch(/\+00:00$/);
  // Rust tool_loop.rs:2645 writes the block before creating a missing assistant at :2756.
  // V20260130__init.sql:99 rejects that first insert; the final save retries from interleaved.
  expect(atStart).toEqual([{ block: existing ? block : null, ids: [block.id] }]);
  expect(t.blocks().map(b => b.type)).toEqual(['content', 'workspace_injection', 'content']);
  expect(t.events().filter(e => e.type === 'workspace_injection').map(e => [e.phase, e.skillStateVersion, e.roundId]))
    .toEqual([['start', 7, undefined], ['chunk', 7, undefined], ['end', 7, undefined]]);
  expect(t.terminals()).toEqual(['stream_start', 'stream_complete']);
});

it('empty inbox and absent workspace do not add a request or injection block', async () => {
  for (const absent of [false, true]) {
    const t = turn(); if (absent) { t.send('keep queued'); t.request.workspaceId = null; }
    responses = [answer('one answer')]; await t.run();
    expect(requests).toHaveLength(1); expect(t.blocks().map(b => b.type)).toEqual(['content']);
    expect(t.peek()).toHaveLength(absent ? 1 : 0);
    expect(t.terminals()).toEqual(['stream_start', 'stream_complete']);
  }
});

it('tool checkpoints share cooldown and two-batch limit; idle and continuation get separate lifetimes', async () => {
  const t = turn();
  let tick = performance.now(); vi.spyOn(performance, 'now').mockImplementation(() => tick);
  const calls: { throttle: InjectionThrottle; max: number; count: number; messages: number }[] = [];
  const check = WorkspaceInjector.prototype.checkAndInject;
  vi.spyOn(WorkspaceInjector.prototype, 'checkAndInject').mockImplementation(function (this: WorkspaceInjector, throttle, ws, session, max) {
    const result = check.call(this, throttle, ws, session, max);
    calls.push({ throttle, max, count: throttle.injectionCount, messages: result.messages.length }); return result;
  });
  let n = 0;
  toolEffect = () => { n++; t.send(`batch-${n}`); if (n >= 3) tick += 100; };
  responses = [tool('call_1'), tool('call_2'), tool('call_3'), tool('call_4'), answer('tools done'),
    tool('call_5'), answer('continuation done')];
  await t.run();
  expect(requests).toHaveLength(7);
  expect(calls.map(c => [c.max, c.count, c.messages])).toEqual([
    [2, 1, 1], [2, 1, 0], [2, 2, 2], [2, 2, 0], [3, 1, 1], [2, 1, 1],
  ]);
  expect(calls.slice(0, 4).every(c => c.throttle === calls[0]!.throttle)).toBe(true);
  expect(calls[4]!.throttle).not.toBe(calls[0]!.throttle);
  expect(calls[5]!.throttle).not.toBe(calls[0]!.throttle);
  expect(calls[5]!.throttle).not.toBe(calls[4]!.throttle);
  const current = requests[0]!.messages.find(m => m.role === 'user')!.content;
  const batches = [[1], [2, 3], [4], [5]].map(ids => `[工作区消息]\n${ids.map(id => `来自 ${t.worker}: [result] batch-${id}\n`).join('')}`);
  const merged = (count: number) => [{ role: 'user', content: [...batches.slice(0, count), current].join('\n\n') }];
  expect(injected(1)).toEqual(merged(1));
  expect(injected(2)).toEqual(injected(1));
  expect(injected(3)).toEqual(merged(2)); expect(injected(4)).toEqual(injected(3));
  expect(injected(5)).toEqual(merged(3)); expect(injected(6)).toEqual(merged(4));
  expect(requests[1]!.messages.findIndex(m => String(m.content).startsWith('[工作区消息]')))
    .toBeLessThan(requests[1]!.messages.findIndex(m => m.role === 'tool'));
  expect(t.peek()).toEqual([]);
  expect(t.events().filter(e => e.type === 'workspace_injection' && e.phase === 'start').map(e => e.roundId))
    .toEqual(['tool-round-0', 'tool-round-2', undefined, 'tool-round-0']);
});

it('tool checkpoint is after post-save and before task-completed return', async () => {
  const t = turn(); completed = true; t.send('completion peer message');
  responses = [tool('completed')];
  await t.run();
  expect(requests).toHaveLength(1); expect(t.peek()).toEqual([]);
  expect(t.blocks().map(b => b.type)).toEqual(['mcp_tool', 'workspace_injection']);
  expect(t.events().filter(e => e.type === 'workspace_injection' && e.phase === 'start').map(e => e.roundId))
    .toEqual(['tool-round-0']);
});

it('first provider error leaves inbox unconsumed and emits only an error terminal', async () => {
  const t = turn(); t.send('not consumed');
  responses = [response => { response.writeHead(400); response.end('bad workspace request'); }];
  await expect(t.run()).rejects.toThrow();
  expect(requests).toHaveLength(1); expect(t.peek().map(m => m.content)).toEqual(['not consumed']);
  expect(t.blocks().filter(b => b.type === 'workspace_injection')).toEqual([]);
  expect(t.terminals()).toEqual(['stream_start', 'stream_error']);
});

it('idle checks once, consumes at most ten, and leaves the remaining queue for another turn', async () => {
  const t = turn(); for (let i = 0; i < 11; i++) t.send(`queued-${i}`);
  responses = [answer('first'), answer('continued')];
  await t.run();
  expect(requests).toHaveLength(2);
  expect(t.peek().map(m => m.content)).toEqual(['queued-10']);
  expect(host.ctx.agentWorkspace.pendingInboxCount(t.workspaceId, t.sessionId)).toBe(1);
  const block = t.blocks().find(b => b.type === 'workspace_injection')!;
  expect(block.content).toBe(`[工作区消息]\n${Array.from({ length: 10 }, (_, i) => `来自 ${t.worker}: [result] queued-${i}\n`).join('')}`);
  expect(block.toolOutput).toMatchObject({ message_count: 10 });
  expect(injected(1)[0]!.content).not.toContain('queued-10');
});

it.each(['idle', 'tool'] as const)('%s drain error is nonfatal and does not inject fabricated messages', async phase => {
  const t = turn(); t.send('retry after failed drain');
  const drain = vi.spyOn(host.ctx.agentWorkspace, 'drainInbox').mockImplementationOnce(() => { throw new Error('inbox read failed'); });
  responses = phase === 'idle' ? [answer('first')] : [tool('failed_check'), answer('after tool'), answer('after idle')];
  await t.run();
  expect(drain).toHaveBeenCalledTimes(phase === 'idle' ? 1 : 2);
  expect(requests).toHaveLength(phase === 'idle' ? 1 : 3);
  expect(t.peek()).toHaveLength(phase === 'idle' ? 1 : 0);
  if (phase === 'tool') {
    expect(injected(1)).toEqual([]);
    expect(injected(2)[0]!.content).toContain('retry after failed drain');
  }
  expect(t.events().filter(e => e.type === 'workspace_injection' && e.phase === 'start').map(e => e.roundId))
    .toEqual(phase === 'idle' ? [] : [undefined]);
  expect(t.terminals()).toEqual(['stream_start', 'stream_complete']);
});

it.each(['block', 'append', 'connection'] as const)('C11 %s pre-save failure preserves model input, events and final-save recovery', async failure => {
  const t = turn(); t.send('survives write failure');
  if (failure === 'block') {
    const create = host.ctx.chatSession.createBlockWithConn.bind(host.ctx.chatSession);
    let failed = false;
    vi.spyOn(host.ctx.chatSession, 'createBlockWithConn').mockImplementation((conn, block) => {
      if (block.type === 'workspace_injection' && !failed) { failed = true; throw new Error('injection write failed'); }
      return create(conn, block);
    });
  } else if (failure === 'append') {
    vi.spyOn(host.ctx.chatSession, 'appendBlockIdToMessageWithConn').mockImplementationOnce(() => { throw new Error('append failed'); });
  } else {
    const check = WorkspaceInjector.prototype.checkAndInject;
    vi.spyOn(WorkspaceInjector.prototype, 'checkAndInject').mockImplementation(function (this: WorkspaceInjector, throttle, ws, session, max) {
      const result = check.call(this, throttle, ws, session, max);
      if (result.messages.length > 0) vi.spyOn(host.ctx.chatSession.database, 'getConnSafe')
        .mockImplementationOnce(() => { throw new Error('connection unavailable'); });
      return result;
    });
  }
  // A tool round pre-creates the assistant message; its checkpoint exercises append, not create.
  responses = [tool('write_fault'), answer('after write fault')]; await t.run();
  expect(requests).toHaveLength(2); expect(injected(1)[0]!.content).toContain('survives write failure');
  expect(t.peek()).toEqual([]);
  const blocks = t.blocks();
  expect(blocks.map(b => b.type)).toEqual(['mcp_tool', 'workspace_injection', 'content']);
  expect(host.ctx.chatSession.getMessage(t.assistantId)!.blockIds).toEqual(blocks.map(b => b.id));
  expect(t.events().filter(e => e.type === 'workspace_injection').map(e => e.phase)).toEqual(['start', 'chunk', 'end']);
  expect(t.terminals()).toEqual(['stream_start', 'stream_complete']);
});

it('continuation provider error propagates after consumed messages and persists the injection', async () => {
  const t = turn(); t.send('consumed before error');
  responses = [answer('first'), response => { response.writeHead(400); response.end('continuation failed'); }];
  await expect(t.run()).rejects.toThrow();
  expect(requests).toHaveLength(2); expect(t.peek()).toEqual([]);
  expect(injected(1)[0]!.content).toContain('consumed before error');
  expect(t.blocks().filter(b => b.type === 'workspace_injection')).toHaveLength(1);
  expect(t.terminals()).toEqual(['stream_start', 'stream_error']);
});

it('cancel during a tool execution does not consume inbox at its post-save checkpoint', async () => {
  const t = turn(); t.send('queued after tool cancel'); toolEffect = () => t.cancel.abort();
  responses = [tool('cancel_tool')];
  await expect(t.run()).rejects.toThrow('Cancelled');
  expect(requests).toHaveLength(1); expect(t.peek().map(m => m.content)).toEqual(['queued after tool cancel']);
  expect(t.events().filter(e => e.type === 'workspace_injection')).toEqual([]);
  expect(t.terminals()).toEqual(['stream_start', 'stream_cancelled']);
});

it.each(['before-injection', 'continuation'] as const)('cancel at %s preserves consumption boundary and WP-003 cleanup', async phase => {
  const t = turn(); t.send('cancel peer');
  const open = (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
  };
  const off = host.ctx.backendEvents.listenWindow(window, `chat_v2_event_${t.sessionId}`, raw => {
    const e = raw as { type: string; phase: string };
    if (e.type === 'content' && e.phase === 'chunk' && requests.length === (phase === 'continuation' ? 2 : 1)) t.cancel.abort();
  });
  responses = phase === 'continuation' ? [answer('before continuation'), open] : [open];
  try { await expect(t.run()).rejects.toThrow('Cancelled'); } finally { off(); }
  expect(requests).toHaveLength(phase === 'continuation' ? 2 : 1);
  expect(t.peek()).toHaveLength(phase === 'continuation' ? 0 : 1);
  expect(t.blocks().filter(b => b.type === 'workspace_injection')).toHaveLength(phase === 'continuation' ? 1 : 0);
  expect(t.terminals()).toEqual(['stream_start', 'stream_cancelled']);
});

interface Scenario {
  id: string; seed: string; steps: { cmd: string; args: Record<string, unknown>; expect?: string }[];
  capture: { events: boolean; db: string[] }; normalize: unknown[];
}
const corpus: { domain: string; commands: string[]; scenarios: Scenario[] } = JSON.parse(
  readFileSync(new URL('../equivalence/workspace.json', import.meta.url), 'utf8'));

it('WAVE0 v0 corpus has five real commands, unique IDs, captures all writes and only backward result references', () => {
  expect(corpus.domain).toBe('chat-pipeline');
  expect(corpus.commands).toEqual(['save_api_configurations', 'workspace_create', 'workspace_create_agent',
    'chat_v2_send_message', 'chat_v2_cancel_stream']);
  expect(new Set(corpus.scenarios.map(s => s.id)).size).toBe(corpus.scenarios.length);
  for (const scenario of corpus.scenarios) {
    expect(scenario.seed).toBe('empty'); expect(scenario.capture).toEqual({ events: true, db: ['*'] });
    expect(scenario.normalize).toEqual([]);
    scenario.steps.forEach((step, index) => {
      expect(corpus.commands).toContain(step.cmd);
      for (const ref of JSON.stringify(step.args).matchAll(/\$\{(\d+)\.([^}]+)\}/g)) {
        expect(Number(ref[1])).toBeLessThan(index);
        expect(scenario.steps[Number(ref[1])]!.expect).not.toBe('error');
      }
    });
  }
});

it.each(corpus.scenarios)('WAVE0 Node-only command smoke: $id (not A/B replay)', async scenario => {
  requests.length = 0; host.events.length = 0;
  const idle = scenario.id.endsWith('.idle'), empty = scenario.id.endsWith('.empty');
  responses = idle ? [answer('first answer'), answer('after workspace')]
    : empty ? [answer('empty queue answer')] : [response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); }];
  const results: unknown[] = [];
  const terminalValues: string[] = [];
  let terminal: Promise<void> | undefined, off: (() => void) | undefined;
  let agent: { workspace_id: string; agent_session_id: string } | undefined;
  try {
    for (const step of scenario.steps) {
      const text = JSON.stringify(step.args).replace(/\$\{(\d+)\.([^}]+)\}/g, (_ref, index: string, field: string) => {
        const value = (results[Number(index)] as Record<string, unknown>)[field];
        expect(typeof value).toBe('string'); return String(value);
      }).replaceAll('http://127.0.0.1:18461/v1', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
      const args = JSON.parse(text) as Record<string, unknown>;
      if (step.cmd === 'chat_v2_send_message' && step.expect !== 'error' && terminal === undefined) {
        const sessionId = (args.request as { sessionId: string }).sessionId;
        terminal = new Promise<void>(resolve => {
          off = host.ctx.backendEvents.listenWindow(window, `chat_v2_session_${sessionId}`, raw => {
            const type = (raw as { eventType: string }).eventType;
            if (['stream_complete', 'stream_cancelled', 'stream_error'].includes(type)) { terminalValues.push(type); resolve(); }
          });
        });
      }
      if (step.expect === 'error') {
        await expect(host.invoke(step.cmd, args, window)).rejects.toBeTypeOf('string'); results.push(null);
      } else {
        const value = await host.invoke(step.cmd, args, window); results.push(value);
        if (step.cmd === 'workspace_create_agent') agent = value as typeof agent;
        if (step.cmd === 'chat_v2_send_message') expect(value).toBe((args.request as { assistantMessageId: string }).assistantMessageId);
      }
    }
    await terminal;
    if (idle || empty) {
      expect(terminalValues).toEqual(['stream_complete']); expect(requests).toHaveLength(idle ? 2 : 1);
      expect(host.ctx.agentWorkspace.peekInbox(agent!.workspace_id, agent!.agent_session_id)).toEqual([]);
      const id = idle ? 'msg_wp061_idle_answer' : 'msg_wp061_empty_answer';
      expect(host.ctx.chatSession.getMessageBlocks(id).filter(b => b.type === 'workspace_injection')).toHaveLength(idle ? 1 : 0);
      if (idle) expect(injected(1)[0]!.content).toContain('来自其他Agent的工作区消息：请保留中文与换行\n第二行');
    } else if (terminal !== undefined) {
      expect(terminalValues).toEqual(['stream_cancelled']);
      if (scenario.id.endsWith('.cancel')) expect(host.ctx.agentWorkspace.peekInbox(agent!.workspace_id, agent!.agent_session_id))
        .toHaveLength(1);
    }
  } finally { off?.(); }
});
