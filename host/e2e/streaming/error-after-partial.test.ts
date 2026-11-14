import { it, expect } from 'vitest';
import { appendFileSync, mkdtempSync } from 'node:fs';
import type { ChatMessage, MessageBlock, SessionEvent } from '../../plugins/chat/api.ts';
import type { ChatV2SendMessageCommandArgs } from '../../../contracts/ipc/generated/L04-chat-session.ts';
import { observedBuiltinReplay, streamingHost } from './__fixtures__/host.ts';

it('error after partial: missing-terminal EOF fails the real send, flushes partial content and saves it before the only stream_error', async () => {
  // Durable markers bypass Vitest worker RPC so a timeout still identifies the last reached phase.
  const stageFile = `${mkdtempSync('/tmp/opencode/x5-error-stages-')}/stages.jsonl`;
  const startedAt = performance.now();
  const phase = (name: string) => appendFileSync(stageFile,
    `${JSON.stringify({ phase: name, elapsedMs: performance.now() - startedAt, pid: process.pid })}\n`);
  phase('test:start');
  const sessionId = 'sess_x5_real_partial_error';
  const userId = 'msg_x5_partial_user';
  const assistantId = 'msg_x5_partial_answer';
  const upstreamError = 'LLM provider 回复流提前结束，未收到完整结束标记；已保留已生成内容，可重试';
  const pipelineError = `LLM error: ${upstreamError}`;
  // Rust model2_pipeline.rs:565–579,7188–7213: actual EOF without a terminal is an LLM failure for an
  // adapter requiring explicit completion. The builtin round is one well-formed content frame, then EOF
  // without finish or [DONE]: no malformed frame or parser throw.
  const script = 'error.eof-after-partial';
  const arrivals: { userSaved: boolean }[] = [];
  let fixture: Awaited<ReturnType<typeof streamingHost>> | undefined;
  try {
    fixture = await streamingHost('error', { diagnostics: true, realProviders: true, onPhase: phase, llmReplay: observedBuiltinReplay(script, () => {
      phase('replay:request');
      arrivals.push({ userSaved: fixture?.host.ctx.chatSession.getMessage(userId) != null });
    }) });
    const { host } = fixture;
    const replay = host.ctx.llmReplay;
    const baseUrl = replay.baseUrl(script);
    const logs: string[] = [`diagnostic stages: ${stageFile}`];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(String(message.args[0])); } });
    expect(host.plugins.map(plugin => plugin.id)).toContain('dstu.platform.diagnostics');
    expect(host.ctx.backgroundTasks).toBeDefined();
    expect(host.ctx.commands.has('chat_v2_send_message')).toBe(true);
    phase('model-config:start');
    await host.ctx.llm.saveApiConfigurations([{ id: 'x5-partial-config', name: 'X5 offline partial error', apiKey: '', authMode: 'none',
      baseUrl, model: 'x5-partial-model', apiProtocol: 'openai_chat_completions', modelAdapter: 'general',
      enabled: true, supportsTools: false, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
      contextWindow: 32768, maxOutputTokens: 128 }]);
    await host.ctx.llm.saveModelAssignments({ model2_config_id: 'x5-partial-config' });
    phase('model-config:ready');
    host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: true, persistStatus: 'active',
      createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });

    const terminalReads: { event: SessionEvent; user: ChatMessage | null; userBlocks: MessageBlock[];
      assistant: ChatMessage | null; blocks: MessageBlock[] }[] = [];
    const stop = host.ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, `chat_v2_session_${sessionId}`, value => {
      const event = value as SessionEvent;
      if (['stream_complete', 'stream_error', 'stream_cancelled'].includes(event.eventType)) {
        phase(`terminal:${event.eventType}`);
        terminalReads.push({ event, user: host.ctx.chatSession.getMessage(userId), userBlocks: host.ctx.chatSession.getMessageBlocks(userId),
          assistant: host.ctx.chatSession.getMessage(assistantId), blocks: host.ctx.chatSession.getMessageBlocks(assistantId) });
      }
    });
    try {
      expect(replay.requests).toEqual([]);
      expect(host.ctx.chatSession.getMessage(userId)).toBeNull();
      expect(host.ctx.chatSession.getMessage(assistantId)).toBeNull();
      const args = { request: { sessionId, content: '部分问题', userMessageId: userId, assistantMessageId: assistantId,
        options: { modelId: 'x5-partial-config', enableThinking: false, memoryEnabled: false, ragEnabled: false,
          webSearchEnabled: false, autoMemoryExtraction: false, contextLimit: 32768, maxTokens: 128 } } } satisfies ChatV2SendMessageCommandArgs;
      // IPC returns the admitted ID; the asynchronously tracked production pipeline owns the failure.
      phase('send:start');
      expect(await host.invoke('chat_v2_send_message', args)).toBe(assistantId);
      phase('send:admitted');
      phase('tasks:drain:start');
      expect(await host.ctx.chatState.shutdownTasks(15_000), logs.join('\n')).toBe(true);
      phase('tasks:drain:done');
      // One streamed request: exactly one counted frame, then the provider ended the response without [DONE].
      expect(replay.requests.map(r => [r.method, r.path, r.scriptId, r.round, r.stream, r.outcome, r.status, r.framesWritten, r.end]),
        logs.join('\n')).toEqual([['POST', `/s/${script}/v1/chat/completions`, script, 0, true, 'served', 200, 1, 'eof']]);
      expect(arrivals).toEqual([{ userSaved: true }]);
      const body = replay.requests[0]!.body;
      expect(body).toMatchObject({ model: 'x5-partial-model', stream: true, messages: [expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('部分问题') })] });
      expect(body).not.toHaveProperty('tools');

      expect(terminalReads, logs.join('\n')).toHaveLength(1);
      const saved = terminalReads[0]!;
      // tool_loop.rs:1745–1760 maps AppError::llm to ChatV2Error::Llm; pipeline.rs:1054 emits its Display.
      expect(saved.event).toMatchObject({ sessionId, eventType: 'stream_error', messageId: assistantId,
        streamGeneration: 1, sequenceId: 1, error: pipelineError });
      expect(saved.user).toMatchObject({ id: userId, sessionId, role: 'user' });
      expect(saved.userBlocks.map(block => [block.type, block.content, block.status])).toEqual([['content', '部分问题', 'success']]);
      expect(saved.assistant).toMatchObject({ id: assistantId, sessionId, role: 'assistant', _meta: { modelId: 'x5-partial-model' } });
      // No Usage frame was received; do not invent token counts for a failed round.
      expect(saved.assistant!._meta?.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'tiktoken' });
      expect(saved.blocks).toHaveLength(1);
      const partial = saved.blocks[0]!;
      // Rust context.rs:790–817 deliberately persists collected text as SUCCESS, even on a failed turn.
      expect(partial).toMatchObject({ messageId: assistantId, type: 'content', status: 'success', content: '部分回答' });
      expect(partial.error ?? null).toBeNull();
      expect(partial.startedAt).toEqual(expect.any(Number));
      expect(partial.endedAt).toEqual(expect.any(Number));
      expect(partial.startedAt!).toBeLessThanOrEqual(partial.endedAt!);
      expect(saved.assistant!.blockIds).toEqual([partial.id]);
      expect(host.ctx.chatSession.getMessage(assistantId)).toEqual(saved.assistant);
      expect(host.ctx.chatSession.getMessageBlocks(assistantId)).toEqual(saved.blocks);
      expect(host.ctx.chatSession.getSessionMessages(sessionId).map(message => message.id)).toEqual([userId, assistantId]);
      expect(host.ctx.chatState.hasActiveStream(sessionId)).toBe(false);
      expect(host.ctx.chatState.trackedTaskCount()).toBe(0);

      // Keep every event. JSON serialization only reproduces main's undefined-key omission (kernel/json.ts:65).
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
          [`chat_v2_event_${sessionId}`, 'content:start'],
          [`chat_v2_event_${sessionId}`, 'content:chunk'],
          [`chat_v2_event_${sessionId}`, 'content:error'],
          [`chat_v2_session_${sessionId}`, 'stream_error'],
        ]);
      expect(trace[0]!.payload).toMatchObject({ sessionId, source: 'backend', contentLength: 4, refCount: 0 });
      expect(trace[1]!.payload).toMatchObject({ sequenceId: 0, messageId: assistantId, streamGeneration: 1, modelId: 'x5-partial-model' });
      expect(trace[2]!.payload).toMatchObject({ sequenceId: 0, roundId: 'tool-round-0', skillStateVersion: 0,
        result: { injectedSkillIds: [], droppedSkillIds: [], missingSkillIds: [], estimatedTokens: 0 } });
      expect(trace[3]!.payload).toMatchObject({ streamEvent, messageId: assistantId, model: 'x5-partial-model', url: `${baseUrl}/chat/completions` });
      expect(trace[3]!.payload.requestBody).toEqual(body);
      expect(trace[4]!.payload).toMatchObject({ id: expect.any(String), model: 'x5-partial-model', request_bytes: expect.any(Number) });
      expect(trace[5]!.payload).toMatchObject({ request_id: streamEvent, stream_event: streamEvent });
      const meta = { sessionId, roundId: 'tool-round-0', blockId: partial.id };
      expect(trace[6]!.payload).toMatchObject({ ...meta, sequenceId: 1, messageId: assistantId });
      expect(trace[7]!.payload).toMatchObject({ ...meta, sequenceId: 2, chunk: '部分回答' });
      expect(trace[8]!.payload).toMatchObject({ ...meta, sequenceId: 3, error: upstreamError });
      expect(trace[8]!.payload).not.toHaveProperty('result');
      expect(trace[9]!.payload).not.toHaveProperty('usage');
      expect(trace[9]!.payload).toMatchObject({ sequenceId: 1, streamGeneration: 1, error: pipelineError });
      expect(await host.ctx.llm.consumePendingCancel(streamEvent)).toBe(false);
      expect(logs).toContain(`[ChatV2::pipeline] Stream failed after output; suppressing automatic retry/failover for session=${sessionId}`);
      expect(logs).toContain(`[ChatV2::pipeline] LLM call failed: ${upstreamError}`);
      expect(logs).toContain(`[ChatV2::handlers] Pipeline error: session_id=${sessionId}, error=${pipelineError}`);
      phase('assertions:done');
    } finally { stop(); }
  } finally {
    phase('cleanup:start');
    await fixture?.dispose();
    phase('cleanup:done');
  }
}, 60_000);
