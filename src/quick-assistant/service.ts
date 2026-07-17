import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { dstu } from '@/dstu/api';
import { ensureInbox, createTodoItem, getActiveTodoSummary } from '@/features/todo/api';
import { ankiApiAdapter } from '@/services/ankiApiAdapter';
import { bulkImportProblemCards } from '@/utils/graphApi';
import { mapFsrsRow } from '@/features/flashcards/store/fsrsReviewStore';
import type { ReviewCard } from '@/features/flashcards/store/fsrsReviewStore';

export type QuickLearningAction = 'ask' | 'explain' | 'translate' | 'summarize' | 'hint';

export interface QuickAnswer {
  sessionId: string;
  answer: string;
}

export interface QuickSearchResult {
  id: string;
  kind: 'resource' | 'conversation';
  title: string;
  snippet: string;
  resourceType?: string;
}

interface BackendEvent {
  type: string;
  phase: string;
  chunk?: string;
}

interface SessionEvent {
  eventType: string;
  error?: string;
}

const ACTION_PROMPTS: Record<QuickLearningAction, string> = {
  ask: '请直接回答下面的问题。先给结论，再给必要解释；如果信息不足，请明确指出。',
  explain: '请把下面内容讲明白。用直观语言说明核心概念、关键关系和一个简短例子，避免无关展开。',
  translate: '请判断原文语言并翻译成中文；如果原文是中文，则翻译成自然英文。保留术语、公式和段落结构，只输出译文。',
  summarize: '请总结下面内容，输出：一句话主旨、3-5 个要点、值得记忆的关键词。',
  hint: '把下面内容视为一道学习题。不要直接给最终答案，先指出考点，再给分层提示和下一步思路。',
};

function compactTitle(text: string, fallback: string): string {
  const first = text.replace(/\s+/g, ' ').trim();
  return (first.slice(0, 32) || fallback).replace(/[\\/:*?"<>|]/g, ' ');
}

export function inferQuickActions(text: string): QuickLearningAction[] {
  const value = text.trim();
  if (!value) return ['ask', 'explain', 'summarize'];
  const looksLikeQuestion = /[?？]$/.test(value) || /^(what|why|how|请问|为什么|如何|怎么)/i.test(value);
  const looksLikeProblem = /(?:求证|证明|计算|解方程|选择题|已知|若|则|\d+[.)、])/i.test(value) || /[=+\-×÷∫∑√]/.test(value);
  const looksLikeForeign = /[A-Za-z]{4,}/.test(value) && !/[\u4e00-\u9fff]/.test(value);
  if (looksLikeProblem) return ['hint', 'explain', 'ask'];
  if (looksLikeForeign) return ['translate', 'explain', 'summarize'];
  if (looksLikeQuestion) return ['ask', 'explain', 'summarize'];
  return ['explain', 'summarize', 'ask'];
}

/**
 * 粘贴内容是否应进入「捕获内容」区而不是提问输入框：
 * 多行或较长的文本属于学习材料（题目、段落、代码），
 * 单行短文本更可能是用户想问的问题本身。
 */
export function isCaptureLikeText(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return value.includes('\n') || value.length > 80;
}

export interface QuickRunHandle {
  sessionId: string;
  /** 流结束（完成 / 出错 / 被停止）后 settle。 */
  completion: Promise<QuickAnswer>;
  /** 请求后端中止当前流式生成；completion 会以「生成已停止」reject。 */
  cancel: () => void;
}

export async function startQuickLearningAction(
  input: string,
  action: QuickLearningAction,
  onChunk: (answer: string) => void,
): Promise<QuickRunHandle> {
  const content = input.trim();
  if (!content) throw new Error('请先输入或粘贴学习内容');

  const session = await invoke<{ id: string }>('chat_v2_create_session', {
    mode: action === 'hint' ? 'analysis' : 'chat',
    title: compactTitle(content, '快速学习'),
    metadata: { source: 'quick-assistant', quickAction: action },
    groupId: null,
  });
  const sessionId = session.id;
  let answer = '';
  let unlistenBlock: UnlistenFn | null = null;
  let unlistenSession: UnlistenFn | null = null;
  const cleanup = () => {
    unlistenBlock?.();
    unlistenSession?.();
    unlistenBlock = null;
    unlistenSession = null;
  };

  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const streamEnded = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  unlistenBlock = await listen<BackendEvent>(`chat_v2_event_${sessionId}`, (event) => {
      const payload = event.payload;
      if (payload.type === 'content' && payload.phase === 'chunk' && payload.chunk) {
        answer += payload.chunk;
        onChunk(answer);
      }
  });
  unlistenSession = await listen<SessionEvent>(`chat_v2_session_${sessionId}`, (event) => {
    if (event.payload.eventType === 'stream_complete') resolveCompletion();
    if (event.payload.eventType === 'stream_error') rejectCompletion(new Error(event.payload.error || '生成失败'));
    if (event.payload.eventType === 'stream_cancelled') rejectCompletion(new Error('生成已停止'));
  });

  const completion = (async () => {
    try {
      await invoke<string>('chat_v2_send_message', {
        request: {
          sessionId,
          content: `${ACTION_PROMPTS[action]}\n\n--- 学习内容 ---\n${content}`,
          options: { maxTokens: 1600, enableThinking: false },
          userMessageId: null,
          assistantMessageId: null,
          userContextRefs: null,
          pathMap: null,
          workspaceId: null,
        },
      });
      await Promise.race([
        streamEnded,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('生成超时，请重试')), 120_000)),
      ]);
      return { sessionId, answer: answer.trim() };
    } finally {
      cleanup();
    }
  })();

  const cancel = () => {
    void invoke('chat_v2_cancel_stream', { sessionId, messageId: 'quick-assistant' }).catch(() => {
      // 流可能已自然结束，或命令不可用；本地兜底让 UI 立即复位。
      rejectCompletion(new Error('生成已停止'));
    });
  };

  return { sessionId, completion, cancel };
}

export async function performImageOcr(dataUrl: string): Promise<string> {
  const response = await invoke<{ ocr_text: string }>('chat_v2_perform_ocr', {
    request: { images: [dataUrl] },
  });
  return response.ocr_text.trim();
}

export async function saveAsNote(source: string, answer: string): Promise<string> {
  const title = compactTitle(source, '快速学习笔记');
  const result = await dstu.create('/', {
    type: 'note',
    name: title,
    content: `# ${title}\n\n## 原始内容\n\n${source.trim()}\n\n## 学习整理\n\n${answer.trim() || '待整理'}\n`,
    metadata: { tags: ['快速学习'], source: 'quick-assistant' },
  });
  if (!result.ok) throw result.error;
  return result.value.id;
}

export async function saveAsMistake(source: string, answer: string): Promise<void> {
  const result = await bulkImportProblemCards({
    cards: [{ content_problem: source.trim(), content_insight: answer.trim() || '待补充解析', tag_names: ['快速收录'] }],
    continue_on_error: false,
  });
  if (result.success_count < 1) throw new Error(result.errors[0] || '错题保存失败');
}

export async function saveAsCard(source: string, answer: string): Promise<void> {
  await ankiApiAdapter.saveAnkiCards({
    documentId: `quick-assistant-${Date.now()}`,
    cards: [{
      front: source.trim(),
      back: answer.trim() || '待补充答案',
      tags: ['quick-assistant'],
      fields: { Front: source.trim(), Back: answer.trim() || '待补充答案' },
    } as any],
  });
}

export async function saveAsTodo(source: string, answer: string): Promise<string> {
  const inbox = await ensureInbox();
  const item = await createTodoItem({
    todoListId: inbox.id,
    title: compactTitle(source, '继续学习'),
    description: answer.trim() ? `${source.trim()}\n\n${answer.trim()}` : source.trim(),
    tags: ['快速学习'],
  });
  return item.id;
}

export async function searchLearningHistory(query: string): Promise<QuickSearchResult[]> {
  const value = query.trim();
  if (value.length < 2) return [];
  const [resources, conversations] = await Promise.all([
    dstu.search(value, { recursive: true, limit: 12 }),
    invoke<Array<{ sessionId: string; sessionTitle: string | null; snippet: string }>>('chat_v2_search_content', {
      query: value,
      limit: 12,
    }).catch(() => []),
  ]);
  const resourceResults = resources.ok ? resources.value.map((item) => ({
    id: item.id,
    kind: 'resource' as const,
    title: item.name,
    snippet: item.path,
    resourceType: item.type,
  })) : [];
  const conversationResults = conversations.map((item) => ({
    id: item.sessionId,
    kind: 'conversation' as const,
    title: item.sessionTitle || '历史会话',
    snippet: item.snippet,
  }));
  return [...resourceResults, ...conversationResults].slice(0, 16);
}

export async function getQuickReviewCard(): Promise<ReviewCard | null> {
  const rows = await invoke<unknown[]>('fsrs_get_due', { limit: 1 });
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') return null;
  return mapFsrsRow(rows[0] as Record<string, unknown>);
}

export async function rateQuickReviewCard(cardStateId: string, rating: number, durationMs: number): Promise<void> {
  await invoke('fsrs_rate', { cardStateId, rating, durationMs });
}

export { getActiveTodoSummary };
