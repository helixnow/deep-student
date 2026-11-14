import { it, expect } from 'vitest';
import type { ChatMessage, MessageBlock, SessionEvent } from '../../plugins/chat/api.ts';
import type { ChatV2SendMessageCommandArgs } from '../../../contracts/ipc/generated/L04-chat-session.ts';
import { observedBuiltinReplay, streamingHost } from './__fixtures__/host.ts';

it('thinking: real send consumes reasoning and content, closes each production block in order and persists both before its only terminal', async () => {
  const sessionId = 'sess_x5_real_thinking';
  const userId = 'msg_x5_thinking_user';
  const assistantId = 'msg_x5_thinking_answer';
  const script = 'success.thinking';
  const arrivals: { userSaved: boolean }[] = [];
  let fixture: Awaited<ReturnType<typeof streamingHost>> | undefined;
  try {
    fixture = await streamingHost('thinking', { diagnostics: true, realProviders: true, llmReplay: observedBuiltinReplay(script,
      () => arrivals.push({ userSaved: fixture?.host.ctx.chatSession.getMessage(userId) != null })) });
    const { host } = fixture;
    const replay = host.ctx.llmReplay;
    const baseUrl = replay.baseUrl(script);
    const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(String(message.args[0])); } });
    expect(host.plugins.map(plugin => plugin.id)).toContain('dstu.platform.diagnostics');
    expect(host.ctx.backgroundTasks).toBeDefined();
    expect(host.ctx.commands.has('chat_v2_send_message')).toBe(true);
    await host.ctx.llm.saveApiConfigurations([{ id: 'x5-thinking-config', name: 'X5 offline thinking', apiKey: '', authMode: 'none',
      baseUrl, model: 'x5-thinking-model', apiProtocol: 'openai_chat_completions', modelAdapter: 'general',
      enabled: true, supportsTools: false, isMultimodal: false, isReasoning: true, supportsReasoning: true,
      isEmbedding: false, isReranker: false, contextWindow: 32768, maxOutputTokens: 128 }]);
    await host.ctx.llm.saveModelAssignments({ model2_config_id: 'x5-thinking-config' });
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: true, persistStatus: 'active',
      createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });

    const terminalReads: { event: SessionEvent; user: ChatMessage | null; assistant: ChatMessage | null; blocks: MessageBlock[] }[] = [];
    const stop = host.ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, `chat_v2_session_${sessionId}`, value => {
      const event = value as SessionEvent;
      if (['stream_complete', 'stream_error', 'stream_cancelled'].includes(event.eventType)) {
        // Read the real owner DB synchronously at terminal delivery, never save or emit from the test.
        terminalReads.push({ event, user: host.ctx.chatSession.getMessage(userId),
          assistant: host.ctx.chatSession.getMessage(assistantId), blocks: host.ctx.chatSession.getMessageBlocks(assistantId) });
      }
    });
    try {
      expect(replay.requests).toEqual([]);
      expect(host.ctx.chatSession.getMessage(userId)).toBeNull();
      expect(host.ctx.chatSession.getMessage(assistantId)).toBeNull();
      const args = { request: { sessionId, content: '思考问题', userMessageId: userId, assistantMessageId: assistantId,
        options: { modelId: 'x5-thinking-config', enableThinking: true, memoryEnabled: false, ragEnabled: false,
          webSearchEnabled: false, autoMemoryExtraction: false, contextLimit: 32768, maxTokens: 128 } } } satisfies ChatV2SendMessageCommandArgs;
      expect(await host.invoke('chat_v2_send_message', args)).toBe(assistantId);
      expect(await host.ctx.chatState.shutdownTasks(15_000), logs.join('\n')).toBe(true);
      // One streamed request through the real OpenAI adapter: four counted frames, then [DONE].
      expect(replay.requests.map(r => [r.method, r.path, r.scriptId, r.round, r.stream, r.outcome, r.status, r.framesWritten, r.end]),
        logs.join('\n')).toEqual([['POST', `/s/${script}/v1/chat/completions`, script, 0, true, 'served', 200, 4, 'done']]);
      expect(arrivals).toEqual([{ userSaved: true }]);
      const body = replay.requests[0]!.body;
      expect(body).toMatchObject({ model: 'x5-thinking-model', stream: true, messages: [expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('思考问题') })] });
      expect(body).not.toHaveProperty('tools');

      expect(terminalReads, logs.join('\n')).toHaveLength(1);
      const saved = terminalReads[0]!;
      // Rust llm_adapter.rs:63–84 reads completion_tokens_details.reasoning_tokens;
      // types.rs:234–275 accumulates it without adding it to totalTokens a second time.
      const usage = { promptTokens: 9, completionTokens: 6, totalTokens: 15, reasoningTokens: 2,
        source: 'mixed', lastRoundPromptTokens: 15, lastRoundInputTokens: 9 };
      expect(saved.event).toMatchObject({ sessionId, eventType: 'stream_complete', messageId: assistantId, streamGeneration: 1 });
      expect(saved.event.usage).toEqual(usage);
      expect(saved.user).toMatchObject({ id: userId, sessionId, role: 'user' });
      expect(saved.assistant).toMatchObject({ id: assistantId, sessionId, role: 'assistant', _meta: { modelId: 'x5-thinking-model' } });
      expect(saved.assistant!._meta?.usage).toEqual(usage);
      expect(saved.blocks).toHaveLength(2);
      expect(saved.blocks.map(block => [block.type, block.content, block.status])).toEqual([
        ['thinking', '先分析', 'success'], ['content', '再回答', 'success'],
      ]);
      const [thinking, content] = saved.blocks;
      expect(thinking!.id).not.toBe(content!.id);
      expect(saved.assistant!.blockIds).toEqual([thinking!.id, content!.id]);
      for (const block of saved.blocks) {
        expect(block.messageId).toBe(assistantId);
        expect(block.startedAt).toEqual(expect.any(Number));
        expect(block.endedAt).toEqual(expect.any(Number));
        expect(block.firstChunkAt).toBe(block.startedAt);
        expect(block.startedAt!).toBeLessThanOrEqual(block.endedAt!);
      }
      expect(thinking!.endedAt!).toBeLessThanOrEqual(content!.startedAt!);
      expect(host.ctx.chatSession.getMessage(assistantId)).toEqual(saved.assistant);
      expect(host.ctx.chatSession.getMessageBlocks(assistantId)).toEqual(saved.blocks);
      expect(host.ctx.chatState.hasActiveStream(sessionId)).toBe(false);

      // No event filtering: Rust model2_pipeline.rs:7395–7412 sends a reasoning summary
      // after hooks close the blocks, even when those hooks handled the incremental reasoning.
      // kernel/json.ts:65 preserves undefined own keys until main's JSON.stringify;
      // assert the raw value too, then compare every event in its serialized serde shape.
      expect(host.events[8]!.payload).toHaveProperty('result', undefined);
      const wire = JSON.parse(JSON.stringify(host.events)) as typeof host.events;
      expect(wire).toHaveLength(host.events.length);
      const trace = wire.map(event => ({ channel: event.event, payload: event.payload as Record<string, unknown> }));
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
          [`chat_v2_event_${sessionId}`, 'thinking:start'],
          [`chat_v2_event_${sessionId}`, 'thinking:chunk'],
          [`chat_v2_event_${sessionId}`, 'thinking:end'],
          [`chat_v2_event_${sessionId}`, 'content:start'],
          [`${streamEvent}_usage`, 'undefined:undefined'],
          [`chat_v2_event_${sessionId}`, 'content:chunk'],
          [`chat_v2_event_${sessionId}`, 'content:end'],
          [`${streamEvent}_reasoning`, 'undefined:undefined'],
          [`chat_v2_session_${sessionId}`, 'stream_complete'],
        ]);
      expect(trace[0]!.payload).toMatchObject({ sessionId, source: 'backend', contentLength: 4, refCount: 0 });
      expect(trace[1]!.payload).toMatchObject({ sequenceId: 0, messageId: assistantId, streamGeneration: 1, modelId: 'x5-thinking-model' });
      expect(trace[2]!.payload).toMatchObject({ sequenceId: 0, roundId: 'tool-round-0', skillStateVersion: 0,
        result: { injectedSkillIds: [], droppedSkillIds: [], missingSkillIds: [], estimatedTokens: 0 } });
      expect(trace[3]!.payload).toMatchObject({ streamEvent, messageId: assistantId, model: 'x5-thinking-model', url: `${baseUrl}/chat/completions` });
      expect(trace[3]!.payload.requestBody).toEqual(body);
      expect(trace[4]!.payload).toMatchObject({ id: expect.any(String), model: 'x5-thinking-model', request_bytes: expect.any(Number) });
      expect(trace[5]!.payload).toMatchObject({ request_id: streamEvent, stream_event: streamEvent });
      const meta = { sessionId, roundId: 'tool-round-0' };
      expect(trace[6]!.payload).toMatchObject({ ...meta, sequenceId: 1, messageId: assistantId, blockId: thinking!.id });
      expect(trace[7]!.payload).toMatchObject({ ...meta, sequenceId: 2, blockId: thinking!.id, chunk: '先分析' });
      expect(trace[8]!.payload).toMatchObject({ ...meta, sequenceId: 3, blockId: thinking!.id });
      // Rust finalize_thinking emits result=None; only content's authoritative end carries text.
      expect(trace[8]!.payload).not.toHaveProperty('result');
      expect(trace[9]!.payload).toMatchObject({ ...meta, sequenceId: 4, messageId: assistantId, blockId: content!.id });
      expect(trace[10]!.payload).toEqual({ prompt_tokens: 9, completion_tokens: 6, total_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 2 } });
      expect(trace[11]!.payload).toMatchObject({ ...meta, sequenceId: 5, blockId: content!.id, chunk: '再回答' });
      expect(trace[12]!.payload).toMatchObject({ ...meta, sequenceId: 6, blockId: content!.id, result: { content: '再回答' } });
      expect(trace[13]!.payload).toEqual({ content: '先分析', is_complete: true,
        chunk_id: `${trace[4]!.payload.id}_reasoning_final_chunk_2` });
      expect(trace[14]!.payload).toMatchObject({ sequenceId: 1, streamGeneration: 1, usage });
    } finally { stop(); }
  } finally {
    await fixture?.dispose();
  }
}, 60_000);
