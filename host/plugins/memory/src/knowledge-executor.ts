/**
 * `KnowledgeExecutor` — Rust `src-tauri/src/chat_v2/tools/knowledge_executor.rs`
 * (`knowledge_extract`: LLM extraction → GLM/Qwen wrap-token cleanup → parse →
 * replace the conversation's pending memory candidates).
 *
 * `pending_memory_candidates` belongs to L16 (anki); candidates are persisted
 * only through its writer port. Like the Rust `main_db` branches, a missing or
 * failing writer is logged and never fails the tool.
 */
import type { ExecutionContext, ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { ModelWrapTokenPolicy, ModelWrapTokenStreamFilter } from '../../../platform/util/portable.ts';
import { KNOWLEDGE_EXTRACT_TOOL, knowledgeCanHandle, knowledgeSensitivity, parseExtractionResponse,
  type KnowledgeCandidate } from './knowledge.ts';
import { argsObject, runResearchTool, toolErrorText, type ResearchToolLog } from './research-tool-runner.ts';
import { stripToolNamespace } from './paper-save.ts';

/** Rust `LLMManager::call_unified_model_2` (non-streaming, background failover). */
export interface KnowledgeModelPort {
  callUnifiedModel2(context: Record<string, unknown>, chatHistory: readonly unknown[], subject: string,
    enableChainOfThought: boolean, imagePaths: string[] | null, taskContext: string | null,
    maxInputTokensOverride: number | null): Promise<{ assistant_message: string }>;
}

export interface PendingMemoryCandidateRow {
  conversationId: string;
  subject: string;
  content: string;
  category: string;
  origin: string;
  userEdited: boolean;
}

/**
 * L16 writer for knowledge_executor.rs:104-166: in one transaction delete the
 * conversation's `status = 'pending'` rows, insert `rows` in order, roll back on
 * any failure; returns the inserted count.
 */
export interface PendingMemoryCandidateWriter {
  replacePendingCandidates(conversationId: string, rows: readonly PendingMemoryCandidateRow[]): number;
}

export interface KnowledgeExecutorDeps {
  /** `ctx.llm_manager`; `null` ⇔ "LLM Manager not available in context". */
  llm(): Partial<KnowledgeModelPort> | null;
  /** `ctx.main_db` candidate writer; `null` skips persistence. */
  candidates(): PendingMemoryCandidateWriter | null;
  log: ResearchToolLog;
}

/** Rust `build_extraction_prompt`. */
export function buildExtractionPrompt(chatHistory: readonly unknown[], focusCategories: readonly string[] | null): string {
  let prompt = '你是知识整理助手。请从以下对话中提取值得长期记住的知识点，生成简要的知识候选条目。\n\n';
  prompt += '【对话记录】\n';
  for (const message of chatHistory) {
    const record = message !== null && typeof message === 'object' && !Array.isArray(message)
      ? message as Record<string, unknown> : {};
    const role = typeof record['role'] === 'string' ? record['role'] : 'user';
    const content = typeof record['content'] === 'string' ? record['content'] : '';
    prompt += `${role}: ${content}\n`;
  }
  prompt += '\n';
  if (focusCategories !== null && focusCategories.length > 0) {
    prompt += `【重点提取类别】${focusCategories.join('、')}\n\n`;
  }
  prompt += `【输出要求】
请以 JSON 数组格式输出知识点候选，每个条目包含：
- content: 知识点内容（简洁明了）
- category: 知识类别（如：概念、定理、公式、方法、技巧、易错点、总结等）

【示例输出】
\`\`\`json
[
  {"content": "勾股定理：直角三角形两直角边的平方和等于斜边的平方", "category": "定理"},
  {"content": "解一元二次方程可用公式法、配方法、因式分解法", "category": "方法"}
]
\`\`\`

【注意事项】
1. 只提取有价值的知识点，忽略寒暄和无关内容
2. 内容要简洁，便于记忆
3. 类别要准确反映知识点性质
4. 如果对话中没有明确的知识点，返回空数组 []

请直接输出 JSON 数组，不要添加额外说明。`;
  return prompt;
}

export class KnowledgeExecutor implements ToolExecutor {
  private readonly deps: KnowledgeExecutorDeps;

  constructor(deps: KnowledgeExecutorDeps) {
    this.deps = deps;
  }

  name(): string { return 'KnowledgeExecutor'; }
  canHandle(toolName: string): boolean { return knowledgeCanHandle(toolName); }
  sensitivityLevel(): ToolSensitivity { return knowledgeSensitivity(); }
  /** Trait default (`ToolConcurrency::Serial`); knowledge_executor.rs does not override it. */
  concurrencyClass(): ToolConcurrency { return 'serial'; }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const tool = stripToolNamespace(call.name);
    this.deps.log.debug(`[KnowledgeExecutor] Executing tool: ${tool} (full: ${call.name})`);
    return runResearchTool(call, ctx, async () => {
      if (tool !== KNOWLEDGE_EXTRACT_TOOL) throw new Error(`Unknown knowledge tool: ${tool}`);
      return this.extract(argsObject(call));
    }, { log: this.deps.log, executorName: 'KnowledgeExecutor', saveBlock: true });
  }

  private async extract(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const conversationId = args['conversation_id'];
    if (typeof conversationId !== 'string') throw new Error("Missing 'conversation_id' parameter");
    const chatHistory = args['chat_history'];
    if (!Array.isArray(chatHistory)) throw new Error("Missing 'chat_history' parameter");
    if (chatHistory.length === 0) throw new Error('chat_history 不能为空');
    const focus = Array.isArray(args['focus_categories'])
      ? (args['focus_categories'] as unknown[]).filter((value): value is string => typeof value === 'string')
      : null;

    const llm = this.deps.llm();
    if (llm === null) throw new Error('LLM Manager not available in context');
    const prompt = buildExtractionPrompt(chatHistory, focus);
    let response: { assistant_message: string };
    try {
      if (llm.callUnifiedModel2 === undefined) throw new Error('callUnifiedModel2 is not published by the llm service');
      response = await llm.callUnifiedModel2({ task: prompt }, [], '通用', false, null, prompt, null);
    } catch (error) {
      throw new Error(`AI 提取失败: ${toolErrorText(error)}`);
    }

    // R4 #3: the failover route is unknown here, so the conservative GLM/Qwen filter always runs.
    const filter = new ModelWrapTokenStreamFilter(ModelWrapTokenPolicy.GlmOrQwen);
    const cleaned = filter.process(response.assistant_message) + filter.flush();

    let candidates: KnowledgeCandidate[];
    try { candidates = parseExtractionResponse(cleaned); }
    catch (error) { throw new Error(`解析提取结果失败: ${toolErrorText(error)}`); }

    const normalizedId = conversationId.startsWith('chat-') ? conversationId.slice(5) : conversationId;
    if (candidates.length > 0) this.persist(normalizedId, candidates);

    this.deps.log.info(`[knowledge_extract] 提取完成: conversation_id=${normalizedId}, candidates=${candidates.length}`);
    return {
      success: true,
      conversation_id: normalizedId,
      candidates,
      count: candidates.length,
      message: candidates.length === 0 ? '未能从对话中提取到知识点' : `成功提取 ${candidates.length} 条知识点候选`,
    };
  }

  private persist(conversationId: string, candidates: readonly KnowledgeCandidate[]): void {
    const writer = this.deps.candidates();
    if (writer === null) {
      this.deps.log.warn('[knowledge_extract] pending memory candidate writer unavailable; candidates not persisted');
      return;
    }
    try {
      const saved = writer.replacePendingCandidates(conversationId, candidates.map(candidate => ({
        conversationId, subject: '通用', content: candidate.content, category: candidate.category,
        origin: 'tool_extract', userEdited: false,
      })));
      if (saved > 0) this.deps.log.info(`[knowledge_extract] 已保存 ${saved} 条候选到数据库`);
    } catch (error) {
      this.deps.log.warn(`[knowledge_extract] 保存候选失败，回滚: ${toolErrorText(error)}`);
    }
  }
}
