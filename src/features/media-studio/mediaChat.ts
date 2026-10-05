/**
 * 「就这门课提问 / 制卡 / 出题」：新开对话，附上本音视频引用并启用课程学习技能。
 *
 * 全部复用既有链路，不新增协议：
 * - 新会话 + 预填：APP_EVENTS.PREFILL_CHAT_INPUT（newSession，autoSend=false，用户把关后发送，
 *   同 PDF 划词出题）；无预填时 APP_EVENTS.CHAT_NEW_SESSION（聊天页就绪握手缓冲）。
 * - 附件：资源库「引用到聊天」同一个 referenceToChat（调用方经 useReferenceToChat 取得）。
 * - 技能：会话 store 的 activateSkill('course-study')（与输入框技能选择器同一入口）。
 */
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { COURSE_STUDY_SKILL_ID } from '@/features/chat/skills/builtin/course-study';
import type { ReferenceToChatParams, ReferenceToChatResult } from '@/features/learning-hub/useReferenceToChat';

/**
 * 等待新会话成为当前会话的上限；超时按当前会话处理（如复用了空草稿会话，不会有切换事件）。
 * 比 App 预填兜底（3s）更宽：冷启动（聊天页尚未挂载 / 手机 LRU 淘汰后重建）时不把引用挂到旧会话。
 */
export const NEW_SESSION_WAIT_MS = 6000;
/** 当前已是空白新对话（隐藏草稿）时聊天页不会切换会话，只等视图切过去 */
export const DRAFT_SESSION_WAIT_MS = 400;

export interface StartMediaChatOptions {
  resourceId: string;
  name: string;
  mimeType?: string;
  size?: number;
  /** 预填指令；缺省只开新对话并附上引用 */
  prompt?: string;
  referenceToChat: (params: ReferenceToChatParams) => Promise<ReferenceToChatResult>;
}

interface SessionManagerLike {
  getCurrentSessionId(): string | null;
  subscribe(listener: (event: { type: string; sessionId?: string | null }) => void): () => void;
  get(sessionId: string): {
    getState(): { activateSkill?: (skillId: string) => Promise<boolean>; sessionMetadata?: unknown };
  } | undefined;
}

/**
 * 当前会话是否为未分组的隐藏草稿（空白新对话）：此时「新建对话」直接复用它，
 * 不会有 current-session-changed（见 useSessionLifecycle.createSession）。
 */
export function isCurrentUngroupedDraft(
  manager: SessionManagerLike,
  draftScopeOf: (metadata: unknown) => string | null,
  ungroupedScope: string,
): boolean {
  const id = manager.getCurrentSessionId();
  const metadata = id ? manager.get(id)?.getState().sessionMetadata : undefined;
  return draftScopeOf(metadata ?? null) === ungroupedScope;
}

/** 派发新会话请求并等待切换完成（或超时），返回最终的当前会话 id */
export function requestNewChatSession(
  sessionManager: SessionManagerLike,
  prompt: string | undefined,
  timeoutMs = NEW_SESSION_WAIT_MS,
): Promise<string | null> {
  const previous = sessionManager.getCurrentSessionId();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      window.clearTimeout(timer);
      resolve(sessionManager.getCurrentSessionId());
    };
    const unsubscribe = sessionManager.subscribe((event) => {
      if (event.type === 'current-session-changed' && event.sessionId && event.sessionId !== previous) finish();
    });
    const timer = window.setTimeout(finish, timeoutMs);
    if (prompt && prompt.trim()) {
      dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, { content: prompt, autoSend: false, newSession: true });
    } else {
      dispatchAppEvent(APP_EVENTS.CHAT_NEW_SESSION);
    }
  });
}

export async function startMediaChat(options: StartMediaChatOptions): Promise<boolean> {
  const [{ sessionManager }, { getDraftSessionScope, getHiddenDraftSessionScope }] = await Promise.all([
    import('@/features/chat/core/session/sessionManager'),
    import('@/features/chat/pages/draftSession'),
  ]);
  const manager = sessionManager as unknown as SessionManagerLike;
  const reusesDraft = isCurrentUngroupedDraft(
    manager,
    (metadata) => getHiddenDraftSessionScope(metadata as Parameters<typeof getHiddenDraftSessionScope>[0]),
    getDraftSessionScope('chat', null),
  );
  const sessionId = await requestNewChatSession(
    manager,
    options.prompt,
    reusesDraft ? DRAFT_SESSION_WAIT_MS : NEW_SESSION_WAIT_MS,
  );

  if (sessionId) {
    try {
      await manager.get(sessionId)?.getState().activateSkill?.(COURSE_STUDY_SKILL_ID);
    } catch (error: unknown) {
      console.warn('[media-studio] activate course-study skill failed:', error);
    }
  }
  const result = await options.referenceToChat({
    sourceType: 'file',
    sourceId: options.resourceId,
    metadata: {
      title: options.name,
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
      ...(typeof options.size === 'number' ? { size: options.size } : {}),
    },
  });
  return result.success;
}
