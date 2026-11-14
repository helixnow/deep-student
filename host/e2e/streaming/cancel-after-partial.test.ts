import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { BackendEvent, ChatMessage, MessageBlock, SessionEvent } from '../../plugins/chat/api.ts';
import type { ChatV2SendMessageCommandArgs, ChatV2CancelStreamCommandArgs } from '../../../contracts/ipc/generated/L04-chat-session.ts';
import { observedBuiltinReplay, streamingHost } from './__fixtures__/host.ts';

it('cancel after partial: the public cancel aborts a still-open HTTP stream, saves partial text and emits only the Rust cancellation trace', async () => {
  const sessionId = 'sess_x5_real_cancel';
  const userId = 'msg_x5_cancel_user';
  const assistantId = 'msg_x5_cancel_answer';
  const artifact = `${mkdtempSync('/tmp/opencode/x5-cancel-')}/trace.json`;
  // The builtin round writes one content frame and holds the response open: no end, Done, parser failure
  // or server-side close. Only the production client's cancellation can close it before test cleanup.
  const script = 'interrupt.hold-after-partial';
  const arrivals: { userSaved: boolean }[] = [];
  let fixture: Awaited<ReturnType<typeof streamingHost>> | undefined;
  try {
    fixture = await streamingHost('cancel', { diagnostics: true, realProviders: true, llmReplay: observedBuiltinReplay(script,
      () => arrivals.push({ userSaved: fixture?.host.ctx.chatSession.getMessage(userId) != null })) });
    const { host } = fixture;
    const replay = host.ctx.llmReplay;
    const baseUrl = replay.baseUrl(script);
    const logged = () => replay.requests.map(r => [r.method, r.path, r.scriptId, r.round, r.stream, r.outcome, r.status, r.framesWritten, r.end]);
    const logs: string[] = [`cancel diagnostic: ${artifact}`];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(String(message.args[0])); } });
    expect(host.plugins.map(plugin => plugin.id)).toContain('dstu.platform.diagnostics');
    expect(host.ctx.commands.has('chat_v2_send_message')).toBe(true);
    expect(host.ctx.commands.has('chat_v2_cancel_stream')).toBe(true);
    await host.ctx.llm.saveApiConfigurations([{ id: 'x5-cancel-config', name: 'X5 offline cancel', apiKey: '', authMode: 'none',
      baseUrl, model: 'x5-cancel-model', apiProtocol: 'openai_chat_completions', modelAdapter: 'general',
      enabled: true, supportsTools: false, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
      contextWindow: 32768, maxOutputTokens: 128 }]);
    await host.ctx.llm.saveModelAssignments({ model2_config_id: 'x5-cancel-config' });
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: true, persistStatus: 'active',
      createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });

    const terminalReads: { event: SessionEvent; user: ChatMessage | null; userBlocks: MessageBlock[];
      assistant: ChatMessage | null; blocks: MessageBlock[] }[] = [];
    let consumed!: (event: BackendEvent) => void;
    let noPartial!: (error: Error) => void;
    const partialConsumed = new Promise<BackendEvent>((resolve, reject) => { consumed = resolve; noPartial = reject; });
    const partialTimer = setTimeout(() => noPartial(new Error(`No production content chunk within 15s; ${artifact}`)), 15_000);
    const stopBlock = host.ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, `chat_v2_event_${sessionId}`, value => {
      const event = value as BackendEvent;
      if (event.type === 'content' && event.phase === 'chunk') { clearTimeout(partialTimer); consumed(event); }
    });
    const stopSession = host.ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, `chat_v2_session_${sessionId}`, value => {
      const event = value as SessionEvent;
      if (['stream_complete', 'stream_error', 'stream_cancelled'].includes(event.eventType)) {
        terminalReads.push({ event, user: host.ctx.chatSession.getMessage(userId), userBlocks: host.ctx.chatSession.getMessageBlocks(userId),
          assistant: host.ctx.chatSession.getMessage(assistantId), blocks: host.ctx.chatSession.getMessageBlocks(assistantId) });
      }
    });
    try {
      expect(replay.requests).toEqual([]);
      expect(host.ctx.chatSession.getMessage(assistantId)).toBeNull();
      const args = { request: { sessionId, content: '取消问题', userMessageId: userId, assistantMessageId: assistantId,
        options: { modelId: 'x5-cancel-config', enableThinking: false, memoryEnabled: false, ragEnabled: false,
          webSearchEnabled: false, autoMemoryExtraction: false, contextLimit: 32768, maxTokens: 128 } } } satisfies ChatV2SendMessageCommandArgs;
      expect(await host.invoke('chat_v2_send_message', args)).toBe(assistantId);
      const chunk = await partialConsumed;
      expect(chunk).toMatchObject({ type: 'content', phase: 'chunk', chunk: '取消前内容' });
      // The one frame is written and consumed; the provider has neither ended nor closed the response.
      expect(logged()).toEqual([['POST', `/s/${script}/v1/chat/completions`, script, 0, true, 'served', 200, 1, null]]);
      expect(replay.openCount()).toBe(1);
      expect(terminalReads).toEqual([]);
      expect(host.ctx.chatState.hasActiveStream(sessionId)).toBe(true);
      expect(host.ctx.chatState.registrationGeneration(sessionId)).toBe(1n);
      const cancelArgs = { sessionId, messageId: assistantId } satisfies ChatV2CancelStreamCommandArgs;
      expect(await host.invoke('chat_v2_cancel_stream', cancelArgs)).toBeNull();
      expect(await host.ctx.chatState.shutdownTasks(15_000), logs.join('\n')).toBe(true);
      expect(await replay.whenIdle(15_000), logs.join('\n')).toBe(true);

      // Preserve all original values before checking for a potential late loser-future event.
      const wire = JSON.parse(JSON.stringify(host.events)) as typeof host.events;
      writeFileSync(artifact, JSON.stringify({ events: wire, terminalReads, logs, replay: replay.requests, arrivals,
        active: host.ctx.chatState.hasActiveStream(sessionId), tasks: host.ctx.chatState.trackedTaskCount() }, null, 2));
      expect(wire).toHaveLength(host.events.length);
      // Still one frame, no EOF or [DONE]: the client closed the held response after the cancel.
      expect(logged()).toEqual([['POST', `/s/${script}/v1/chat/completions`, script, 0, true, 'served', 200, 1, 'client-closed']]);
      expect(replay.openCount()).toBe(0);
      expect(arrivals).toEqual([{ userSaved: true }]);
      const body = replay.requests[0]!.body;
      expect(body).toMatchObject({ model: 'x5-cancel-model', stream: true, messages: [expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('取消问题') })] });
      expect(body).not.toHaveProperty('tools');
      expect(terminalReads, logs.join('\n')).toHaveLength(1);
      const saved = terminalReads[0]!;
      expect(saved.event).toMatchObject({ sessionId, eventType: 'stream_cancelled', messageId: assistantId, streamGeneration: 1, sequenceId: 1 });
      expect(saved.user).toMatchObject({ id: userId, sessionId, role: 'user' });
      expect(saved.userBlocks.map(block => [block.type, block.content, block.status])).toEqual([['content', '取消问题', 'success']]);
      expect(saved.assistant).toMatchObject({ id: assistantId, sessionId, role: 'assistant', _meta: { modelId: 'x5-cancel-model' } });
      expect(saved.assistant!._meta?.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'tiktoken' });
      expect(saved.blocks).toHaveLength(1);
      const partial = saved.blocks[0]!;
      // pipeline.rs:946–995 + context.rs:790–817: cancelled turn retains collected text as SUCCESS.
      expect(partial).toMatchObject({ id: chunk.blockId, messageId: assistantId, type: 'content', status: 'success', content: '取消前内容' });
      expect(partial.error ?? null).toBeNull();
      expect(partial.startedAt!).toBeLessThanOrEqual(partial.endedAt!);
      expect(saved.assistant!.blockIds).toEqual([partial.id]);
      expect(host.ctx.chatSession.getMessage(assistantId)).toEqual(saved.assistant);
      expect(host.ctx.chatSession.getMessageBlocks(assistantId)).toEqual(saved.blocks);
      expect(host.ctx.chatSession.getSessionMessages(sessionId).map(message => message.id)).toEqual([userId, assistantId]);
      expect(host.ctx.chatState.hasActiveStream(sessionId)).toBe(false);
      expect(host.ctx.chatState.trackedTaskCount()).toBe(0);

      const trace = wire.map(event => ({ channel: event.event, payload: event.payload as Record<string, unknown> }));
      expect(trace[4]!.channel).toMatch(new RegExp(
        `^chat_v2_event_${sessionId}_var_${assistantId}_run_[a-f0-9]{32}__stream_generation__1_start$`));
      const streamEvent = trace[4]!.channel.slice(0, -'_start'.length);
      // pipeline.rs:1143–1148 drops execute_with_tools on external cancellation;
      // the dropped future cannot emit a late content:end or raw scoped event after the terminal.
      expect(trace.map(event => [event.channel, event.payload.eventType ?? `${event.payload.type}:${event.payload.phase}`]), artifact)
        .toEqual([
          ['chat_v2_request_audit', 'undefined:undefined'],
          [`chat_v2_session_${sessionId}`, 'stream_start'],
          [`chat_v2_event_${sessionId}`, 'skill_injection_audit:end'],
          ['chat_v2_llm_request_body', 'undefined:undefined'],
          [`${streamEvent}_start`, 'undefined:undefined'],
          [`${streamEvent}_id`, 'undefined:undefined'],
          [`chat_v2_event_${sessionId}`, 'content:start'],
          [`chat_v2_event_${sessionId}`, 'content:chunk'],
          [`chat_v2_session_${sessionId}`, 'stream_cancelled'],
        ]);
      expect(trace[1]!.payload).toMatchObject({ sequenceId: 0, streamGeneration: 1, messageId: assistantId });
      expect(trace[2]!.payload).toMatchObject({ sequenceId: 0, roundId: 'tool-round-0', skillStateVersion: 0 });
      expect(trace[3]!.payload).toMatchObject({ streamEvent, messageId: assistantId, model: 'x5-cancel-model', url: `${baseUrl}/chat/completions` });
      expect(trace[3]!.payload.requestBody).toEqual(body);
      expect(trace[5]!.payload).toMatchObject({ request_id: streamEvent, stream_event: streamEvent });
      expect(trace[6]!.payload).toMatchObject({ sequenceId: 1, sessionId, messageId: assistantId, blockId: partial.id, roundId: 'tool-round-0' });
      expect(trace[7]!.payload).toMatchObject({ sequenceId: 2, sessionId, blockId: partial.id, chunk: '取消前内容' });
      expect(trace[8]!.payload).not.toHaveProperty('error');
      expect(trace[8]!.payload).not.toHaveProperty('usage');
      expect(await host.ctx.llm.consumePendingCancel(streamEvent)).toBe(false);
      expect(logs).toContain(`[ChatV2::handlers] Stream cancellation requested: session=${sessionId}, message=${assistantId}`);
      expect(logs).toContain(`[ChatV2::handlers] Pipeline cancelled: session_id=${sessionId}`);
      expect(logs).toContain(`[LLM Manager] 取消信号已成功发送到 channel: ${streamEvent}`);
    } finally { clearTimeout(partialTimer); stopBlock(); stopSession(); }
  } finally {
    await fixture?.dispose();
  }
}, 60_000);
