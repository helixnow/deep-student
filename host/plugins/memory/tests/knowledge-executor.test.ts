import { afterEach, describe, expect, it } from 'vitest';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import type { PendingMemoryCandidateRow } from '../src/knowledge-executor.ts';
import { buildExtractionPrompt } from '../src/knowledge-executor.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

type ModelCall = { context: unknown; history: unknown; subject: string; cot: boolean; task: string | null };

async function setup(options: {
  reply?: string | (() => Promise<string>);
  withLlm?: boolean;
  writer?: ((conversationId: string, rows: readonly PendingMemoryCandidateRow[]) => number) | null;
} = {}) {
  const registry = new AgentToolExecutorRegistry();
  const modelCalls: ModelCall[] = [];
  const saved: Array<{ conversationId: string; rows: readonly PendingMemoryCandidateRow[] }> = [];
  const reply = options.reply ?? '[]';
  const writer = options.writer === undefined
    ? (conversationId: string, rows: readonly PendingMemoryCandidateRow[]) => {
      saved.push({ conversationId, rows }); return rows.length;
    }
    : options.writer;
  current = await setupMemoryHost({
    agentTools: { registerToolExecutors: executors => registry.register(executors) },
    ...(options.withLlm === false ? {} : {
      llmMethods: {
        async callUnifiedModel2(context: unknown, history: unknown, subject: string, cot: boolean,
          _images: unknown, task: string | null) {
          modelCalls.push({ context, history, subject, cot, task });
          return { assistant_message: typeof reply === 'string' ? reply : await reply() };
        },
      },
    }),
    ...(writer === null ? {} : { services: { pendingMemoryCandidates: { replacePendingCandidates: writer } } }),
  });
  const executor = registry.all().find(entry => entry.name() === 'KnowledgeExecutor') as ToolExecutor;
  return { ...current, executor, modelCalls, saved };
}

async function call(executor: ToolExecutor, args: unknown) {
  const events: string[] = [];
  const ctx = {
    session_id: 'sess_k', message_id: 'msg_k', block_id: 'blk_k', variant_id: null,
    cancellation_token: null, isCancelled: () => false,
    emitToolCallStart: () => { events.push('start'); },
    emitToolCallEnd: () => { events.push('end'); },
    emitToolCallError: (error: string) => { events.push(`error:${error}`); },
    saveToolBlock: () => { events.push('save'); },
  } as unknown as ExecutionContext;
  const result = await executor.execute({ id: 'call_k', name: 'builtin-knowledge_extract', arguments: args }, ctx);
  return { result, events, output: result.output as Record<string, any> };
}

const history = [{ role: 'user', content: '勾股定理是什么' }, { role: 'assistant', content: 'a²+b²=c²' }];

describe('KnowledgeExecutor', () => {
  it('registers under the roster name with its tool name, sensitivity and default concurrency', async () => {
    const { executor } = await setup();
    expect(executor.canHandle('builtin-knowledge_extract')).toBe(true);
    expect(executor.canHandle('knowledge_extract')).toBe(true);
    expect(executor.canHandle('knowledge_internalize')).toBe(false);
    expect(executor.sensitivityLevel?.('builtin-knowledge_extract')).toBe('low');
    expect(executor.concurrencyClass?.('builtin-knowledge_extract')).toBe('serial');
  });

  it('extracts through call_unified_model_2, strips wrap tokens and replaces pending candidates', async () => {
    const reply = '<|begin_of_box|>[{"content":"勾股定理","category":"定理"},{"content":"x","category":5},'
      + '{"content":"配方法","category":"方法"}]<|end_of_box|>';
    const { executor, modelCalls, saved, infos } = await setup({ reply });
    const { result, events, output } = await call(executor, {
      conversation_id: 'chat-conv_1', chat_history: history, focus_categories: ['定理', 3],
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(events).toEqual(['start', 'end', 'save']);
    expect(output).toEqual({
      success: true, conversation_id: 'conv_1',
      candidates: [{ content: '勾股定理', category: '定理' }, { content: '配方法', category: '方法' }],
      count: 2, message: '成功提取 2 条知识点候选',
    });
    const prompt = buildExtractionPrompt(history, ['定理']);
    expect(prompt).toContain('user: 勾股定理是什么\nassistant: a²+b²=c²\n');
    expect(prompt).toContain('【重点提取类别】定理\n\n');
    expect(modelCalls).toEqual([{ context: { task: prompt }, history: [], subject: '通用', cot: false, task: prompt }]);
    expect(saved).toEqual([{ conversationId: 'conv_1', rows: [
      { conversationId: 'conv_1', subject: '通用', content: '勾股定理', category: '定理', origin: 'tool_extract', userEdited: false },
      { conversationId: 'conv_1', subject: '通用', content: '配方法', category: '方法', origin: 'tool_extract', userEdited: false },
    ] }]);
    expect(infos).toContain('[knowledge_extract] 已保存 2 条候选到数据库');
  });

  it('an empty fenced extraction succeeds without touching the candidate table', async () => {
    const { executor, saved } = await setup({ reply: '```json\n[]\n```' });
    const { result, output } = await call(executor, { conversation_id: 'conv_2', chat_history: history });
    expect(result.success).toBe(true);
    expect(output).toMatchObject({ conversation_id: 'conv_2', candidates: [], count: 0, message: '未能从对话中提取到知识点' });
    expect(saved).toEqual([]);
  });

  it('a missing or failing candidate writer only warns', async () => {
    const reply = '[{"content":"c","category":"概念"}]';
    const missing = await setup({ reply, writer: null });
    const first = await call(missing.executor, { conversation_id: 'conv_3', chat_history: history });
    expect(first.result.success).toBe(true);
    expect(first.output['count']).toBe(1);
    expect(missing.warnings.some(line => line.includes('candidate writer unavailable'))).toBe(true);
    await missing.dispose(); current = undefined;

    const failing = await setup({ reply, writer: () => { throw new Error('disk full'); } });
    const second = await call(failing.executor, { conversation_id: 'conv_3', chat_history: history });
    expect(second.result.success).toBe(true);
    expect(failing.warnings).toContain('[knowledge_extract] 保存候选失败，回滚: disk full');
  });

  it('argument, model and parse failures are tool errors with the Rust messages', async () => {
    const cases: Array<[Parameters<typeof setup>[0], unknown, string]> = [
      [{}, { chat_history: history }, "Missing 'conversation_id' parameter"],
      [{}, { conversation_id: 'c' }, "Missing 'chat_history' parameter"],
      [{}, { conversation_id: 'c', chat_history: [] }, 'chat_history 不能为空'],
      [{ withLlm: false }, { conversation_id: 'c', chat_history: history }, 'LLM Manager not available in context'],
      [{ reply: () => Promise.reject(new Error('quota')) }, { conversation_id: 'c', chat_history: history }, 'AI 提取失败: quota'],
      [{ reply: '{"content":"x"}' }, { conversation_id: 'c', chat_history: history }, '解析提取结果失败: 响应不是 JSON 数组'],
    ];
    for (const [options, args, message] of cases) {
      const host = await setup(options);
      const { result, events } = await call(host.executor, args);
      expect(result.success).toBe(false);
      expect(result.error).toBe(message);
      expect(events).toEqual(['start', `error:${message}`, 'save']);
      expect(host.saved).toEqual([]);
      await host.dispose(); current = undefined;
    }
  });
});
