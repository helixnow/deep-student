import { it, expect } from 'vitest';
import type { ChatMessage, MessageBlock, SessionEvent } from '../../plugins/chat/api.ts';
import type { ChatV2SendMessageCommandArgs } from '../../../contracts/ipc/generated/L04-chat-session.ts';
import { observedBuiltinReplay, streamingHost } from './__fixtures__/host.ts';

it('normal answer: real send consumes the fake provider over HTTP/SSE, persists before terminal and flushes the production sink', async () => {
  const sessionId = 'sess_x5_real_answer';
  const userId = 'msg_x5_real_user';
  const assistantId = 'msg_x5_real_answer';
  const script = 'success.answer';
  const arrivals: { userSaved: boolean }[] = [];
  let fixture: Awaited<ReturnType<typeof streamingHost>> | undefined;
  try {
    // Only provider bytes are scripted (the replay's builtin round). No test calls pipeline hooks, persistence or emitters.
    fixture = await streamingHost('answer', { diagnostics: true, realProviders: true, llmReplay: observedBuiltinReplay(script,
      () => arrivals.push({ userSaved: fixture?.host.ctx.chatSession.getMessage(userId) != null })) });
    const { host } = fixture;
    const replay = host.ctx.llmReplay;
    const baseUrl = replay.baseUrl(script);
    const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(String(message.args[0])); } });
    expect(host.plugins.map(plugin => plugin.id)).toContain('dstu.platform.diagnostics');
    expect(host.ctx.backgroundTasks).toBeDefined();
    expect(host.ctx.commands.has('chat_v2_send_message')).toBe(true);
    await host.ctx.llm.saveApiConfigurations([{ id: 'x5-local-config', name: 'X5 offline answer', apiKey: '', authMode: 'none',
      baseUrl, model: 'x5-local-model', apiProtocol: 'openai_chat_completions', modelAdapter: 'general',
      enabled: true, supportsTools: false, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
      contextWindow: 32768, maxOutputTokens: 128 }]);
    await host.ctx.llm.saveModelAssignments({ model2_config_id: 'x5-local-config' });
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: true, persistStatus: 'active',
      createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });

    const terminalReads: { event: SessionEvent; user: ChatMessage | null; assistant: ChatMessage | null; blocks: MessageBlock[] }[] = [];
    const stop = host.ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, `chat_v2_session_${sessionId}`, value => {
      const event = value as SessionEvent;
      if (['stream_complete', 'stream_error', 'stream_cancelled'].includes(event.eventType)) {
        terminalReads.push({ event, user: host.ctx.chatSession.getMessage(userId),
          assistant: host.ctx.chatSession.getMessage(assistantId), blocks: host.ctx.chatSession.getMessageBlocks(assistantId) });
      }
    });
    try {
      expect(replay.requests).toEqual([]);
      expect(host.ctx.chatSession.getMessage(userId)).toBeNull();
      expect(host.ctx.chatSession.getMessage(assistantId)).toBeNull();
      const args = { request: { sessionId, content: '固定问题', userMessageId: userId, assistantMessageId: assistantId,
        options: { modelId: 'x5-local-config', enableThinking: false, memoryEnabled: false, ragEnabled: false,
          webSearchEnabled: false, autoMemoryExtraction: false, contextLimit: 32768, maxTokens: 128 } } } satisfies ChatV2SendMessageCommandArgs;
      expect(await host.invoke('chat_v2_send_message', args)).toBe(assistantId);
      // send returns at task admission; drain the real tracked pipeline, without creating any terminal ourselves.
      expect(await host.ctx.chatState.shutdownTasks(15_000), logs.join('\n')).toBe(true);
      // One streamed request through the real OpenAI adapter: four counted frames, then [DONE].
      expect(replay.requests.map(r => [r.method, r.path, r.scriptId, r.round, r.stream, r.outcome, r.status, r.framesWritten, r.end]),
        logs.join('\n')).toEqual([['POST', `/s/${script}/v1/chat/completions`, script, 0, true, 'served', 200, 4, 'done']]);
      expect(arrivals).toEqual([{ userSaved: true }]);
      const body = replay.requests[0]!.body;
      expect(body).toMatchObject({ model: 'x5-local-model', stream: true, messages: [expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('固定问题') })] });
      expect(body).not.toHaveProperty('tools');

      expect(terminalReads, logs.join('\n')).toHaveLength(1);
      const saved = terminalReads[0]!;
      expect(saved.event).toMatchObject({ sessionId, eventType: 'stream_complete', messageId: assistantId,
        streamGeneration: 1, usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
      expect(saved.user).toMatchObject({ id: userId, sessionId, role: 'user' });
      expect(saved.assistant).toMatchObject({ id: assistantId, sessionId, role: 'assistant',
        _meta: { modelId: 'x5-local-model', usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } } });
      expect(saved.blocks).toHaveLength(1);
      expect(saved.blocks[0]).toMatchObject({ messageId: assistantId, type: 'content', status: 'success', content: '固定回答' });
      expect(host.ctx.chatSession.getMessage(assistantId)).toEqual(saved.assistant);
      expect(host.ctx.chatSession.getMessageBlocks(assistantId)).toEqual(saved.blocks);
      expect(host.ctx.chatState.hasActiveStream(sessionId)).toBe(false);

      // Inspect ALL outbound events, not a filtered text-only trace: request/skill audit remain visible.
      const trace = host.events.map(event => ({ channel: event.event, payload: event.payload as Record<string, unknown> }));
      expect(trace[4]!.channel).toMatch(new RegExp(
        `^chat_v2_event_${sessionId}_var_${assistantId}_run_[a-f0-9]{32}__stream_generation__1_start$`));
      const streamEvent = trace[4]!.channel.slice(0, -'_start'.length);
      expect(trace.map(event => [event.channel, event.payload.eventType ?? `${event.payload.type}:${event.payload.phase}`]))
        .toEqual([
          ['chat_v2_request_audit', 'undefined:undefined'],
          [`chat_v2_session_${sessionId}`, 'stream_start'],
          [`chat_v2_event_${sessionId}`, 'skill_injection_audit:end'],
          ['chat_v2_llm_request_body', 'undefined:undefined'],
          [`${streamEvent}_start`, 'undefined:undefined'],
          [`${streamEvent}_id`, 'undefined:undefined'],
          [`chat_v2_event_${sessionId}`, 'content:start'],
          [`${streamEvent}_usage`, 'undefined:undefined'],
          [`chat_v2_event_${sessionId}`, 'content:chunk'],
          [`chat_v2_event_${sessionId}`, 'content:end'],
          [`chat_v2_session_${sessionId}`, 'stream_complete'],
        ]);
      expect(trace[0]!.payload).toMatchObject({ sessionId, source: 'backend', contentLength: 4, refCount: 0 });
      expect(trace[2]!.payload).toMatchObject({ sequenceId: 0, roundId: 'tool-round-0', skillStateVersion: 0,
        result: { injectedSkillIds: [], droppedSkillIds: [], missingSkillIds: [], estimatedTokens: 0 } });
      expect(trace[3]!.payload).toMatchObject({ streamEvent, messageId: assistantId, model: 'x5-local-model', url: `${baseUrl}/chat/completions` });
      // The provider received exactly the request body the adapter built and audited.
      expect(trace[3]!.payload.requestBody).toEqual(body);
      expect(trace[4]!.payload).toMatchObject({ id: expect.any(String), model: 'x5-local-model', request_bytes: expect.any(Number) });
      expect(trace[5]!.payload).toMatchObject({ request_id: streamEvent, stream_event: streamEvent });
      expect(trace[7]!.payload).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
      const blockId = saved.blocks[0]!.id;
      expect(trace[6]!.payload).toMatchObject({ sessionId, messageId: assistantId, blockId, sequenceId: 1, roundId: 'tool-round-0' });
      expect(trace[8]!.payload).toMatchObject({ sessionId, blockId, sequenceId: 2, chunk: '固定回答' });
      expect(trace[9]!.payload).toMatchObject({ sessionId, blockId, sequenceId: 3, result: { content: '固定回答' } });
      expect(trace[1]!.payload).toMatchObject({ sequenceId: 0, messageId: assistantId, streamGeneration: 1 });
      expect(trace[10]!.payload).toMatchObject({ sequenceId: 1 });
    } finally { stop(); }
  } finally {
    await fixture?.dispose();
  }
}, 60_000);
