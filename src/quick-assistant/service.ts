import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import i18n from '@/i18n';
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
  /** 资源的 DSTU 路径（主窗口 openResource 需要路径而非 id） */
  path?: string;
}

export interface QuickReviewSnapshot {
  card: ReviewCard | null;
  /** 到期卡片总数（最多探测 50 张） */
  dueCount: number;
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

function tt(key: string, options?: Record<string, unknown>): string {
  return String(i18n.t(`quickAssistant:${key}`, options));
}

// 发送时按当前语言取 prompt，不能在模块加载时冻结（语言切换后会过期）。
function actionPrompt(action: QuickLearningAction): string {
  return tt(`prompts.${action}`);
}

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

/**
 * 剪贴板内容是否更像口令 / 密钥而不是学习材料：
 * 单行、无空格、无 CJK、非 URL、且大小写 / 数字 / 符号混杂。
 * 只用于跳过「呼出时自动读剪贴板」，不影响用户手动粘贴。
 */
export function looksLikeSecret(text: string): boolean {
  const value = text.trim();
  if (value.length < 12 || value.length > 128) return false;
  if (/[\s\u4e00-\u9fff]/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  // 含常见数学 / 公式符号的短表达式是核心学习场景，不视为密钥
  if (/[=+*^()]/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return classes >= 3;
}

export interface QuickRunHandle {
  sessionId: string;
  /** 流结束（完成 / 出错 / 被停止）后 settle。 */
  completion: Promise<QuickAnswer>;
  /** 请求后端中止当前流式生成；completion 会以「生成已停止」reject。 */
  cancel: () => void;
}

/** 用户主动停止生成时的错误标记，UI 据此降级为普通提示而非错误。 */
export const QUICK_RUN_STOPPED = 'QuickRunStopped';

function stoppedError(): Error {
  const error = new Error(tt('errors.stopped'));
  error.name = QUICK_RUN_STOPPED;
  return error;
}

/** 快速学习会话统一归入的分组，避免散落在主窗口会话列表里。 */
const QUICK_GROUP_NAMES = ['快速学习', 'Quick Learning'];
let quickGroupId: string | null | undefined;

async function resolveQuickLearningGroupId(): Promise<string | null> {
  if (quickGroupId !== undefined) return quickGroupId;
  try {
    const groups = await invoke<Array<{ id: string; name: string }>>('chat_v2_list_groups', {
      status: 'active',
      workspaceId: null,
    });
    const existing = groups.find((group) => QUICK_GROUP_NAMES.includes(group.name));
    if (existing) {
      quickGroupId = existing.id;
    } else {
      const created = await invoke<{ id: string }>('chat_v2_create_group', {
        request: { name: tt('service.group_name') },
      });
      quickGroupId = created.id;
    }
  } catch {
    // 分组失败不阻塞提问，退回未分组
    quickGroupId = null;
  }
  return quickGroupId;
}

export async function startQuickLearningAction(
  input: string,
  action: QuickLearningAction,
  onChunk: (answer: string) => void,
): Promise<QuickRunHandle> {
  const content = input.trim();
  if (!content) throw new Error(tt('service.need_content'));

  const session = await invoke<{ id: string }>('chat_v2_create_session', {
    mode: action === 'hint' ? 'analysis' : 'chat',
    title: compactTitle(content, tt('service.default_title')),
    metadata: { source: 'quick-assistant', quickAction: action },
    groupId: await resolveQuickLearningGroupId(),
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
    if (event.payload.eventType === 'stream_error') rejectCompletion(new Error(event.payload.error || tt('errors.generation_failed')));
    if (event.payload.eventType === 'stream_cancelled') rejectCompletion(stoppedError());
  });

  const completion = (async () => {
    try {
      await invoke<string>('chat_v2_send_message', {
        request: {
          sessionId,
          content: `${actionPrompt(action)}\n\n${tt('prompts.content_separator')}\n${content}`,
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
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(tt('errors.timeout'))), 120_000)),
      ]);
      return { sessionId, answer: answer.trim() };
    } finally {
      cleanup();
    }
  })();

  const cancel = () => {
    void invoke('chat_v2_cancel_stream', { sessionId, messageId: 'quick-assistant' }).catch(() => {
      // 流可能已自然结束，或命令不可用；本地兜底让 UI 立即复位。
      rejectCompletion(stoppedError());
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

/**
 * 「存为笔记」豁免共享 saveTextAsNote 流程（裁决：docs/dev/wave2-B-r3-quick-assistant-exemption.md）。
 * 1. 本窗是全局快捷键呼出的轻量独立 WebView（main.tsx 按 window=quick-assistant 分流，
 *    刻意不挂载完整 App）；共享流程两大支柱在此均无宿主：FolderPickerDialog 会把
 *    learning-hub finder 整链拖进轻量窗，showGlobalNotification 与 DSTU_OPEN_NOTE
 *    的监听方（WorkbenchEventBridge / useChatPageEvents）都只活在 main 窗。
 * 2. 产品语义是「系统级剪贴快速落笔记」：与错题/卡片/待办四键并列、一击即存，
 *    弹目录树会打断捕获流；跨窗打开走既有 openQuickAssistantTarget 桥。
 *    落点保持根目录 + metadata.source='quick-assistant'，非漏迁。
 */
export async function saveAsNote(source: string, answer: string): Promise<string> {
  const title = compactTitle(source, tt('service.note_title'));
  const result = await dstu.create('/', {
    type: 'note',
    name: title,
    content: `# ${title}\n\n## ${tt('service.note_source_heading')}\n\n${source.trim()}\n\n## ${tt('service.note_answer_heading')}\n\n${answer.trim() || tt('service.note_pending')}\n`,
    metadata: { tags: [tt('service.tag')], source: 'quick-assistant' },
  });
  if (!result.ok) throw result.error;
  return result.value.id;
}

export async function saveAsMistake(source: string, answer: string): Promise<void> {
  const result = await bulkImportProblemCards({
    cards: [{ content_problem: source.trim(), content_insight: answer.trim() || tt('service.mistake_pending'), tag_names: [tt('service.mistake_tag')] }],
    continue_on_error: false,
  });
  if (result.success_count < 1) throw new Error(result.errors[0] || tt('errors.mistake_save_failed'));
}

export async function saveAsCard(source: string, answer: string): Promise<void> {
  await ankiApiAdapter.saveAnkiCards({
    documentId: `quick-assistant-${Date.now()}`,
    cards: [{
      front: source.trim(),
      back: answer.trim() || tt('service.card_pending'),
      tags: ['quick-assistant'],
      fields: { Front: source.trim(), Back: answer.trim() || tt('service.card_pending') },
    } as any],
  });
}

export async function saveAsTodo(source: string, answer: string): Promise<string> {
  const inbox = await ensureInbox();
  const item = await createTodoItem({
    todoListId: inbox.id,
    title: compactTitle(source, tt('service.todo_title')),
    description: answer.trim() ? `${source.trim()}\n\n${answer.trim()}` : source.trim(),
    tags: [tt('service.tag')],
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
    path: item.path,
  })) : [];
  const conversationResults = conversations.map((item) => ({
    id: item.sessionId,
    kind: 'conversation' as const,
    title: item.sessionTitle || tt('search.conversation_fallback'),
    snippet: item.snippet,
  }));
  return [...resourceResults, ...conversationResults].slice(0, 16);
}

export async function getQuickReviewSnapshot(): Promise<QuickReviewSnapshot> {
  const rows = await invoke<unknown[]>('fsrs_get_due', { limit: 50 });
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') {
    return { card: null, dueCount: 0 };
  }
  return {
    card: mapFsrsRow(rows[0] as Record<string, unknown>),
    dueCount: rows.length,
  };
}

export async function rateQuickReviewCard(cardStateId: string, rating: number, durationMs: number): Promise<void> {
  await invoke('fsrs_rate', { cardStateId, rating, durationMs });
}

export { getActiveTodoSummary };
