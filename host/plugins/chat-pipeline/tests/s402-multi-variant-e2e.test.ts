/**
 * S4-02 Real Full-Stack E2E Reproduction & Regression Test:
 * Real L04 `chat_v2_send_message` → Real L03 `PipelineExecution.execute` → Real HTTP SSE LLM
 * → Real `PipelineFinalPersistence` → Real SQLite → Real L04 `chat_v2_retry_message` (preserveVariant: true)
 * → Real L03 `PipelineExecution.execute` → Real L04 `chat_v2_switch_variant(var_v1_...)`
 * → Real L04 `chat_v2_load_session` & `chat_v2_load_messages_page` (with strict ContractSet debug: true).
 *
 * Uses realistic production `SendOptions.skillEmbeddedTools` size (~290 KB UTF-8, matching
 * `sendOptions.ts` injecting all ~49 runtime-admitted builtin skill groups for lazy `load_skills`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPipelineHost } from './chat-host.ts';
import type { ChatMessage } from '../../chat/api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
let replyText = 'v1 answer';
let respond: (response: ServerResponse) => void;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  respond(response);
});
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const window = { window: 'main', webview: 'main' } as const;

/**
 * Generates a realistic ~290 KB UTF-8 `skillEmbeddedTools` map matching production
 * `buildSendOptions()` (49 admitted builtin skill groups, Chinese descriptions + JSON schemas).
 */
function buildRealisticBuiltinSkillEmbeddedTools(groupCount = 49): Record<string, Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}>> {
  const embedded: Record<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> = {};
  for (let g = 0; g < groupCount; g += 1) {
    const skillId = `builtin-skill-group-${String(g).padStart(2, '0')}`;
    embedded[skillId] = Array.from({ length: 6 }, (_, t) => ({
      name: `builtin-tool_${g}_${t}`,
      description: `内置工具 ${g}-${t}：用于执行学习工作台、知识检索、题库解析与多模态上下文处理的完整参数说明文本。`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索或处理的目标查询文本，支持中英文自然语言与结构化筛选条件。' },
          scope: { type: 'string', enum: ['session', 'workspace', 'global'], description: '作用域范围限定参数。' },
          limit: { type: 'number', description: '返回结果数量上限，默认 20 条。' },
          filters: {
            type: 'object',
            description: '附加过滤条件对象，包括标签、来源类型、时间窗口与排序权重配置。',
            properties: {
              tags: { type: 'array', items: { type: 'string' }, description: '标签列表过滤。' },
              sourceType: { type: 'string', description: '来源类型标识。' },
            },
          },
        },
        required: ['query'],
      },
    }));
  }
  return embedded;
}

const REALISTIC_EMBEDDED_TOOLS = buildRealisticBuiltinSkillEmbeddedTools(49);

function waitForStreamTerminal(sessionId: string): Promise<{ eventType: string; messageId: string }> {
  return new Promise((resolve) => {
    const off = host.ctx.backendEvents.listenWindow(window, `chat_v2_session_${sessionId}`, (raw) => {
      const event = raw as { eventType?: string; messageId?: string };
      if (!event.eventType || !['stream_complete', 'stream_error', 'stream_cancelled'].includes(event.eventType)) {
        return;
      }
      off();
      resolve({ eventType: event.eventType, messageId: event.messageId ?? '' });
    });
  });
}

async function waitForTrackedDrain(): Promise<void> {
  await vi.waitFor(() => expect(host.ctx.chatState.trackedTaskCount()).toBe(0), { timeout: 10_000 });
}

beforeAll(async () => {
  // Confirm fixture matches real production UTF-8 payload size (> 256 KB hard variants_json limit).
  expect(Buffer.byteLength(JSON.stringify(REALISTIC_EMBEDDED_TOOLS), 'utf8')).toBeGreaterThan(262_144);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  host = await createPipelineHost({ llm: true, diagnostics: true });
  await host.invoke('save_api_configurations', {
    configs: [{
      id: 's402-config',
      name: 'S402 Real E2E Model',
      apiKey: '',
      authMode: 'none',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: 's402-deepseek-v3',
      apiProtocol: 'openai_chat_completions',
      modelAdapter: 'general',
      enabled: true,
      supportsTools: true,
      isMultimodal: false,
      isReasoning: false,
      isEmbedding: false,
      isReranker: false,
    }],
  });
  respond = (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      sse({
        choices: [{ delta: { content: replyText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }) + 'data: [DONE]\n\n',
    );
  };
}, 60_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await host?.dispose();
});

describe('S4-02 full-stack multi-variant persistence through real pipeline and SQLite', () => {
  it('preserves var_v1 and var_v2 across regenerate, switch_variant, and session reload with real ~290KB skillEmbeddedTools', async () => {
    const sessionId = 'sess_s402_real_e2e_1';
    const userId = 'msg_mwvney9i_g8yjrb_0';
    const assistantId = 'msg_mwvney9i_g8yjrb_1';
    host.ctx.chatSession.createSession({
      id: sessionId,
      mode: 'chat',
      titleLocked: true,
      persistStatus: 'active',
      createdAt: '2026-11-25T05:00:00Z',
      updatedAt: '2026-11-25T05:00:00Z',
    });

    const baseSendOptions = {
      modelId: 's402-config',
      disableTools: true,
      enableThinking: false,
      memoryEnabled: false,
      ragEnabled: false,
      webSearchEnabled: false,
      autoMemoryExtraction: false,
      skillEmbeddedTools: REALISTIC_EMBEDDED_TOOLS,
      skillDependencies: { 'builtin-skill-group-00': ['builtin-skill-group-01'] },
      mcpToolSchemas: [{
        name: 'load_skills',
        description: '按需加载技能',
        inputSchema: { type: 'object', properties: { skill_ids: { type: 'array', items: { type: 'string' } } } },
      }],
    };

    // 1. Turn 1: real chat_v2_send_message → real PipelineExecution.execute → SQLite
    replyText = '第一版完整回答 (v1)';
    const turn1Done = waitForStreamTerminal(sessionId);
    await expect(host.invoke('chat_v2_send_message', {
      request: {
        sessionId,
        content: '请简要解释量子纠缠',
        userMessageId: userId,
        assistantMessageId: assistantId,
        options: baseSendOptions,
      },
    }, window)).resolves.toBe(assistantId);
    expect((await turn1Done).eventType).toBe('stream_complete');
    await waitForTrackedDrain();

    // 2. Click "重新生成": real chat_v2_retry_message with preserveVariant: true over argsJson IPC
    replyText = '第二版重新生成回答 (v2)';
    const turn2Done = waitForStreamTerminal(sessionId);
    const retryRes = await host.invoke<{ message_id: string; new_variant_id?: string }>('chat_v2_retry_message', {
      sessionId,
      messageId: assistantId,
      options: {
        ...baseSendOptions,
        preserveVariant: true,
      },
    }, window);
    expect(retryRes.message_id).toBe(assistantId);
    expect(retryRes.new_variant_id).toMatch(/^var_/);
    expect((await turn2Done).eventType).toBe('stream_complete');
    await waitForTrackedDrain();

    // 3. Click "上一版本": real chat_v2_switch_variant to var_v1_msg_mwvney9i_g8yjrb_1
    const v1Id = `var_v1_${assistantId}`;
    await expect(host.invoke('chat_v2_switch_variant', {
      sessionId,
      messageId: assistantId,
      variantId: v1Id,
    }, window)).resolves.toBeNull();

    // 4. Reload session: chat_v2_load_session + chat_v2_load_messages_page (strict ContractSet checkResult)
    const loaded = await host.invoke<{
      messages: ChatMessage[];
      blocks: Array<{ id: string; content?: string }>;
    }>('chat_v2_load_session', { sessionId, tailLimit: 50 }, window);

    const reloadedMsg = loaded.messages.find(m => m.id === assistantId)!;
    expect(reloadedMsg).toBeDefined();
    expect(reloadedMsg.activeVariantId).toBe(v1Id);
    expect(reloadedMsg.variants).toHaveLength(2);
    expect(reloadedMsg.variants![0]).toMatchObject({
      id: v1Id,
      status: 'success',
      meta: { versioned: true },
    });
    expect(reloadedMsg.variants![1]).toMatchObject({
      id: retryRes.new_variant_id,
      status: 'success',
      meta: { versioned: true },
    });

    const blockMap = new Map(loaded.blocks.map(b => [b.id, b.content]));
    expect(reloadedMsg.variants![0]!.blockIds.map(id => blockMap.get(id))).toEqual(['第一版完整回答 (v1)']);
    expect(reloadedMsg.variants![1]!.blockIds.map(id => blockMap.get(id))).toEqual(['第二版重新生成回答 (v2)']);

    const paged = await host.invoke<{
      messages: ChatMessage[];
      blocks: Array<{ id: string; content?: string }>;
    }>('chat_v2_load_messages_page', { sessionId, offset: 0, limit: 50 }, window);
    const pagedMsg = paged.messages.find(m => m.id === assistantId)!;
    expect(pagedMsg.variants).toHaveLength(2);
    expect(pagedMsg.activeVariantId).toBe(v1Id);
  });

  it('preserves var_v1 even when regenerating a pre-upgrade legacy SQLite message with >280KB meta_json.skillRuntimeBefore', async () => {
    const sessionId = 'sess_s402_real_e2e_legacy';
    const userId = 'msg_legacy_u1';
    const assistantId = 'msg_legacy_a1';
    host.ctx.chatSession.createSession({
      id: sessionId,
      mode: 'chat',
      titleLocked: true,
      persistStatus: 'active',
      createdAt: '2026-11-25T05:00:00Z',
      updatedAt: '2026-11-25T05:00:00Z',
    });

    // Seed a pre-upgrade Turn 1 row directly in SQLite whose meta_json already holds the bloated ~290 KB skillEmbeddedTools.
    const db = host.ctx.chatSession.database.getConnSafe();
    host.ctx.chatSession.createMessage({
      id: userId,
      sessionId,
      role: 'user',
      blockIds: ['blk_legacy_u1'],
      timestamp: 1000,
    });
    host.ctx.chatSession.createBlock({
      id: 'blk_legacy_u1',
      messageId: userId,
      type: 'content',
      status: 'success',
      content: '旧版消息提问',
      blockIndex: 0,
    });
    host.ctx.chatSession.createMessage({
      id: assistantId,
      sessionId,
      role: 'assistant',
      blockIds: ['blk_legacy_a1'],
      timestamp: 2000,
      _meta: {
        modelId: 's402-deepseek-v3',
        skillRuntimeBefore: {
          activeSkillIds: ['builtin-skill-group-00'],
          skillEmbeddedTools: REALISTIC_EMBEDDED_TOOLS,
        },
      },
    });
    host.ctx.chatSession.createBlock({
      id: 'blk_legacy_a1',
      messageId: assistantId,
      type: 'content',
      status: 'success',
      content: '旧版回答 v1',
      blockIndex: 0,
    });
    const rawMetaSize = Buffer.byteLength(
      db.pluck<string>('SELECT meta_json FROM chat_v2_messages WHERE id = ?', [assistantId]) ?? '',
      'utf8',
    );
    expect(rawMetaSize).toBeGreaterThan(262_144);

    // Regenerate this pre-upgrade message twice (v1 -> v2 -> v3)
    replyText = '旧版消息重生 v2';
    const done2 = waitForStreamTerminal(sessionId);
    const retry2 = await host.invoke<{ message_id: string; new_variant_id?: string }>('chat_v2_retry_message', {
      sessionId,
      messageId: assistantId,
      options: {
        modelId: 's402-config',
        disableTools: true,
        enableThinking: false,
        memoryEnabled: false,
        ragEnabled: false,
        webSearchEnabled: false,
        autoMemoryExtraction: false,
        activeSkillIds: Object.keys(REALISTIC_EMBEDDED_TOOLS),
        skillEmbeddedTools: REALISTIC_EMBEDDED_TOOLS,
        preserveVariant: true,
      },
    }, window);
    expect((await done2).eventType).toBe('stream_complete');
    await waitForTrackedDrain();

    replyText = '旧版消息重生 v3';
    const done3 = waitForStreamTerminal(sessionId);
    const retry3 = await host.invoke<{ message_id: string; new_variant_id?: string }>('chat_v2_retry_message', {
      sessionId,
      messageId: assistantId,
      options: {
        modelId: 's402-config',
        disableTools: true,
        enableThinking: false,
        memoryEnabled: false,
        ragEnabled: false,
        webSearchEnabled: false,
        autoMemoryExtraction: false,
        activeSkillIds: Object.keys(REALISTIC_EMBEDDED_TOOLS),
        skillEmbeddedTools: REALISTIC_EMBEDDED_TOOLS,
        preserveVariant: true,
      },
    }, window);
    expect((await done3).eventType).toBe('stream_complete');
    await waitForTrackedDrain();

    // Switch back to var_v1 — MUST succeed and all 3 versions MUST persist!
    const v1Id = `var_v1_${assistantId}`;
    await expect(host.invoke('chat_v2_switch_variant', {
      sessionId,
      messageId: assistantId,
      variantId: v1Id,
    }, window)).resolves.toBeNull();

    const loaded = await host.invoke<{ messages: ChatMessage[] }>('chat_v2_load_session', { sessionId, tailLimit: 50 }, window);
    const reloaded = loaded.messages.find(m => m.id === assistantId)!;
    expect(reloaded.activeVariantId).toBe(v1Id);
    expect(reloaded.variants?.map(v => v.id)).toEqual([v1Id, retry2.new_variant_id, retry3.new_variant_id]);
  });
});
