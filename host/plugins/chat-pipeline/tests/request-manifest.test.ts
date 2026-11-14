/** D1 request manifest: sha256 + byte counts of everything chat-pipeline hands to the model layer, Host log only. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { LlmModel2Streaming, UnifiedModel2StreamInput } from '../../llm/api.ts';
import type { ChatToolRuntime, JsonValue, PipelineSendRequest } from '../api.ts';
import { PlanGateManager } from '../src/authority-mode.ts';
import { historyMessage } from '../src/history-replay.ts';
import { makeTransientSkillMessage } from '../src/microcompact.ts';
import { CITATION_GUIDE, PromptBuilder, RESPONSE_LANGUAGE_RULE } from '../src/prompt-builder.ts';
import { combineUserContent } from '../src/context.ts';
import { REQUEST_MANIFEST_TAG, buildRequestManifest, topLevelSections, withRequestManifest,
  type RequestManifest } from '../src/request-manifest.ts';
import { messageForModel2 } from '../src/unified-text-stream.ts';
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import { createPipelineHost } from './chat-host.ts';

const hasher = createWebCrypto();
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = (text: string) => ({ sha256: sha(text), bytes: Buffer.byteLength(text, 'utf8') });
const sink = { emitStart() {}, emitChunk() {}, emitEnd() {}, emitError() {} } as unknown as UnifiedModel2StreamInput['sink'];
const input = (patch: Partial<UnifiedModel2StreamInput>): UnifiedModel2StreamInput => ({
  context: {}, chatHistory: [], subject: '', enableChainOfThought: true, enableThinking: false,
  taskContext: 'chat_v2', sink, streamEvent: 'chat_v2_event_s_r', messageId: 'msg_1', ...patch,
});

describe('manifest contents', () => {
  it('splits the PromptBuilder system prompt into its top-level sections', () => {
    const prompt = new PromptBuilder('基础指令').build()!;
    const sections = topLevelSections(prompt, hasher);
    const names = sections.map(section => section.name);
    expect(names.slice(names.indexOf('system_instructions'))).toEqual(['system_instructions', 'response_language', 'citation_rules']);
    expect(sections.find(section => section.name === 'system_instructions')).toMatchObject(
      digest('<system_instructions>\n基础指令\n</system_instructions>'));
    expect(sections.find(section => section.name === 'response_language')).toMatchObject(digest(RESPONSE_LANGUAGE_RULE));
    expect(sections.find(section => section.name === 'citation_rules')).toMatchObject(digest(CITATION_GUIDE));
    expect(sections.reduce((sum, section) => sum + section.bytes, 0) + 2 * (sections.length - 1)).toBe(Buffer.byteLength(prompt, 'utf8'));
  });

  it('keeps untagged text and an unclosed tag as one leading untagged section', () => {
    const prompt = 'free text\n<one>\nbody\n</one>\n<open>\nnever closed';
    expect(topLevelSections(prompt, hasher)).toEqual([
      { name: '(untagged)', ...digest('free text\n<open>\nnever closed') },
      { name: 'one', ...digest('<one>\nbody\n</one>') },
    ]);
  });

  it('classifies skills, workspace injections, injected context, tools and context without logging any text', () => {
    const workspace = historyMessage('user', '[工作区消息]\n来自 w: [result] 秘密进度');
    workspace.metadata = { workspace_injection: true, workspace_id: 'ws_1' };
    const volatile = new PromptBuilder(null).withUserProfile('秘密偏好').withActiveGoal('秘密目标').buildTurnVolatileBlocks()!;
    const ref = { resourceId: 'res_1', hash: 'h', typeId: 'note',
      formattedBlocks: [{ type: 'text' as const, text: '<note id="n1">\n秘密笔记\n</note>' }] };
    const combined = combineUserContent('你好', '<runtime_facts>\n秘密时间\n</runtime_facts>', [ref], volatile);
    const injectedText = combined.text.slice(combined.text.indexOf('<injected_context>'));
    const multimodal = historyMessage('user', '');
    multimodal.multimodal_content = [{ type: 'text', text: '<user_query>q</user_query>' }, { type: 'text', text: '<injected_context>' },
      { type: 'text', text: '<note id="n2">\nx\n</note>' }, { type: 'image_url', mediaType: 'image/png', base64: 'AAAA' },
      { type: 'text', text: '</injected_context>' }];
    const history = [makeTransientSkillMessage('skill-a', '秘密技能正文'), workspace,
      historyMessage('user', combined.text), historyMessage('assistant', '答'), multimodal].map(messageForModel2);
    const tools: JsonValue[] = [{ type: 'function', function: { name: 'builtin-echo_text', parameters: { type: 'object' } } }, { name: 'bare' }];
    const manifest = buildRequestManifest(input({ chatHistory: history, systemPromptOverride: '<a>\nx\n</a>',
      modelOverrideId: 'cfg', context: { custom_tools: tools, prefetched_rag_sources: [{ title: '秘密来源' }], rag_enabled: true } }), hasher);
    expect(manifest.injectedContext[0]!.sections.map(section => section.name))
      .toEqual(['runtime_facts', 'note', 'user_profile', 'active_goal']);
    expect(manifest.injectedContext[0]!.sections[1]).toEqual({ name: 'note', ...digest('<note id="n1">\n秘密笔记\n</note>') });
    expect(manifest).toEqual({
      streamEvent: 'chat_v2_event_s_r', messageId: 'msg_1', taskContext: 'chat_v2', model: 'cfg',
      systemPrompt: { ...digest('<a>\nx\n</a>'), sections: [{ name: 'a', ...digest('<a>\nx\n</a>') }] },
      skills: [{ id: 'skill-a', message: 0, ...digest(history[0]!.content) }],
      workspace: [{ message: 1, ...digest(workspace.content) }],
      injectedContext: [{ message: 2, images: 0, ...digest(injectedText), sections: manifest.injectedContext[0]!.sections },
        { message: 4, images: 1, ...digest(JSON.stringify(multimodal.multimodal_content!.slice(1))),
          sections: [{ name: 'note', ...digest('<note id="n2">\nx\n</note>') }] }],
      tools: { ...digest(JSON.stringify(tools)), items: [
        { name: 'builtin-echo_text', ...digest(JSON.stringify(tools[0])) }, { name: 'bare', ...digest(JSON.stringify(tools[1])) }] },
      context: [{ key: 'prefetched_rag_sources', ...digest('[{"title":"秘密来源"}]') }, { key: 'rag_enabled', ...digest('true') }],
      history: { messages: 5, ...digest(JSON.stringify(history)) },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/秘密|你好|AAAA/);
  });
});

describe('port wrapper', () => {
  const output = { assistant_message: 'ok', raw_response: null, chain_of_thought_details: null, cancelled: false };
  const port = (): LlmModel2Streaming & { calls: UnifiedModel2StreamInput[] } => {
    const calls: UnifiedModel2StreamInput[] = [];
    return { calls, callUnifiedModel2Stream: async value => { calls.push(value); return output; },
      callUnifiedModel2StreamWithConfig: async (_config, _retries, value) => { calls.push(value); return output; } };
  };

  it('logs one manifest per request on both entry points and forwards the same input', async () => {
    const service = port(), log = { info: vi.fn(), warn: vi.fn() };
    const wrapped = withRequestManifest(service, log, hasher);
    const request = input({ systemPromptOverride: 'p' });
    await expect(wrapped.callUnifiedModel2Stream(request)).resolves.toBe(output);
    await wrapped.callUnifiedModel2StreamWithConfig({} as never, 2, request);
    expect(service.calls).toEqual([request, request]);
    expect(service.calls[0]).toBe(request);
    expect(log.info.mock.calls.map(([line]) => JSON.parse(String(line).slice(REQUEST_MANIFEST_TAG.length + 1)).systemPrompt.sha256))
      .toEqual([sha('p'), sha('p')]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a manifest failure only warns; the request still goes out unchanged and provider errors stay intact', async () => {
    const service = port(), log = { info: vi.fn(), warn: vi.fn() };
    const request = input({ context: { broken: 1n as never } });
    await expect(withRequestManifest(service, log, hasher).callUnifiedModel2Stream(request)).resolves.toBe(output);
    expect(service.calls[0]).toBe(request);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn.mock.calls[0]![0]).toMatch(/^\[ChatV2::request-manifest\] skipped \(stream_event=chat_v2_event_s_r\): .*BigInt/);
    const failing = { ...service, callUnifiedModel2Stream: async () => { throw new Error('provider down'); } };
    await expect(withRequestManifest(failing, log, hasher).callUnifiedModel2Stream(input({}))).rejects.toThrow('provider down');
  });
});

describe('real pipeline', () => {
  let host: Awaited<ReturnType<typeof createPipelineHost>>;
  const responses: ((response: ServerResponse) => void)[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the real provider request. */ }
    const next = responses.shift();
    if (next) next(response);
    else { response.writeHead(400); response.end('unexpected provider request'); }
  });
  const answer = (text: string) => (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
  };
  const runtime: ChatToolRuntime = {
    concurrencyClass: () => 'read_only',
    execute: async () => { throw new Error('no tool call is scripted'); },
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
    await host.ctx.llm.saveApiConfigurations([{ id: 'manifest-config', name: 'manifest test', apiKey: '', authMode: 'none',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'manifest-model',
      apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true,
      enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
  }, 60_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await host?.dispose();
  });

  it('every provider request of a send logs a manifest that matches exactly what the model layer received', async () => {
    const sessionId = 'manifest_session', worker = 'manifest_worker', assistantId = 'msg_manifest';
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: true, persistStatus: 'active',
      createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
    const workspace = host.ctx.agentWorkspace.createWorkspace(sessionId, 'D1');
    host.ctx.agentWorkspace.registerAgent(workspace.id, sessionId, 'coordinator', null, null);
    host.ctx.agentWorkspace.registerAgent(workspace.id, worker, 'worker', null, null);
    host.ctx.agentWorkspace.sendMessage(workspace.id, worker, sessionId, 'result', '工作区进度');
    const received: UnifiedModel2StreamInput[] = [];
    const model2 = host.ctx.llmModel2Streaming.callUnifiedModel2Stream.bind(host.ctx.llmModel2Streaming);
    vi.spyOn(host.ctx.llmModel2Streaming, 'callUnifiedModel2Stream').mockImplementation(async value => {
      received.push(structuredClone({ ...value, sink: null, window: null }) as unknown as UnifiedModel2StreamInput);
      return model2(value);
    });
    const info = vi.spyOn(host.ctx.logger, 'info');
    const request: PipelineSendRequest = { sessionId, content: '请总结', userMessageId: 'user_manifest',
      assistantMessageId: assistantId, workspaceId: workspace.id,
      options: { modelId: 'manifest-config', enableThinking: false, memoryEnabled: false, ragEnabled: false,
        webSearchEnabled: false, autoMemoryExtraction: false,
        mcpToolSchemas: [{ name: 'builtin-echo_text', description: 'Echo',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } };
    responses.push(answer('第一轮'), answer('看过工作区'));
    await expect(host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' }, request, new AbortController().signal, null))
      .resolves.toBe(assistantId);

    const manifests = info.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith(`${REQUEST_MANIFEST_TAG} `))
      .map(line => JSON.parse(line.slice(REQUEST_MANIFEST_TAG.length + 1)) as RequestManifest);
    expect(received).toHaveLength(2);
    expect(manifests).toHaveLength(2);
    manifests.forEach((manifest, index) => {
      const sent = received[index]!;
      expect(manifest.streamEvent).toBe(sent.streamEvent);
      expect(manifest.systemPrompt).toMatchObject(digest(sent.systemPromptOverride!));
      expect(manifest.systemPrompt!.sections.map(section => section.name)).toContain('system_instructions');
      expect(manifest.history).toEqual({ messages: sent.chatHistory.length, ...digest(JSON.stringify(sent.chatHistory)) });
      expect(manifest.tools!.items.map(item => item.name)).toEqual(['builtin-echo_text']);
      expect(manifest.tools).toMatchObject(digest(JSON.stringify(sent.context.custom_tools)));
    });
    expect(manifests[0]!.workspace).toEqual([]);
    const injection = received[1]!.chatHistory.find(message => message.metadata?.workspace_injection === true)!;
    expect(injection.content).toContain('工作区进度');
    expect(manifests[1]!.workspace).toEqual([{ message: received[1]!.chatHistory.indexOf(injection), ...digest(injection.content) }]);
    expect(JSON.stringify(host.ctx.chatSession.getMessage(assistantId))).not.toContain('sha256');
  });
});
