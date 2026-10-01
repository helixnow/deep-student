/**
 * 笔记来源（溯源回链）：笔记从哪次对话 / 哪份资料的哪一页来，并能一键回去。
 *
 * 存储：notes.props._origin（JSON 字符串）。后端笔记 metadata 只接受 title/tags/
 * isFavorite/props，`_` 前缀键在属性面板与标签建议中隐藏，不污染学习者的自由属性。
 * Agent 建笔记时由后端写入（canvas_executor.rs NOTE_ORIGIN_PROP_KEY），
 * 前端「存为笔记」类入口经 attachNoteOrigin 写入。
 */
import { dstu, updatedAtToVersionToken, type DstuNode } from '@/dstu';
import { requestChatSessionNavigation } from '@/features/chat/navigation/pendingChatNavigation';
import { getChatMessageListScrollHandle } from '@/features/chat/components/messageListScrollRegistry';

export const NOTE_ORIGIN_PROP_KEY = '_origin';
const MAX_TITLE = 80;

export type NoteOrigin =
  | { kind: 'chat'; sessionId: string; messageId?: string; title?: string }
  | { kind: 'resource'; resourceId: string; page?: number; title?: string };

const clip = (value: string | undefined) => (value && value.length > MAX_TITLE ? `${value.slice(0, MAX_TITLE - 1)}…` : value);

export function serializeNoteOrigin(origin: NoteOrigin): string {
  return JSON.stringify(origin.kind === 'chat'
    ? { kind: 'chat', sessionId: origin.sessionId, messageId: origin.messageId, title: clip(origin.title) }
    : { kind: 'resource', resourceId: origin.resourceId, page: origin.page, title: clip(origin.title) });
}

export function parseNoteOrigin(raw: unknown): NoteOrigin | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof value.title === 'string' ? value.title : undefined;
    if (value.kind === 'chat' && typeof value.sessionId === 'string' && value.sessionId) {
      return { kind: 'chat', sessionId: value.sessionId, messageId: typeof value.messageId === 'string' ? value.messageId : undefined, title };
    }
    if (value.kind === 'resource' && typeof value.resourceId === 'string' && value.resourceId) {
      const page = typeof value.page === 'number' && Number.isInteger(value.page) && value.page > 0 ? value.page : undefined;
      return { kind: 'resource', resourceId: value.resourceId, page, title };
    }
  } catch { /* 畸形值视为无来源 */ }
  return null;
}

export function noteOriginFromNode(node: Pick<DstuNode, 'metadata'> | null | undefined): NoteOrigin | null {
  const props = (node?.metadata as { props?: Record<string, unknown> } | undefined)?.props;
  return parseNoteOrigin(props?.[NOTE_ORIGIN_PROP_KEY]);
}

/** 为已创建的笔记记录来源；合并现有 props 并带版本基线写入。失败不影响笔记本身。 */
export async function attachNoteOrigin(noteId: string, origin: NoteOrigin): Promise<boolean> {
  const path = `/${noteId}`;
  const current = await dstu.get(path);
  if (!current.ok || !current.value) return false;
  const props = { ...((current.value.metadata as { props?: Record<string, unknown> } | undefined)?.props ?? {}) };
  props[NOTE_ORIGIN_PROP_KEY] = serializeNoteOrigin(origin);
  const version = updatedAtToVersionToken(current.value.updatedAt) ?? undefined;
  const result = await dstu.setMetadata(path, { props }, version);
  return result.ok;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 回到来源：对话 → 切到聊天并滚到那条消息；资料 → 打开并跳到那一页。 */
export async function navigateToNoteOrigin(origin: NoteOrigin): Promise<void> {
  if (origin.kind === 'chat') {
    window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'chat-v2' } }));
    requestChatSessionNavigation(origin.sessionId);
    if (!origin.messageId) return;
    // 消息列表挂载并注册滚动句柄后再定位（冷启动 / 跨视图切换需要一点时间）
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const handle = getChatMessageListScrollHandle(origin.sessionId);
      if (handle) {
        await handle.scrollToMessage(origin.messageId);
        return;
      }
      await wait(100);
    }
    return;
  }
  const dstuPath = `/${origin.resourceId}`;
  window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'learning-hub', openResource: dstuPath } }));
  if (origin.page) {
    for (const delay of [300, 700, 1400]) {
      window.setTimeout(() => {
        document.dispatchEvent(new CustomEvent('pdf-ref:focus', {
          detail: { sourceId: origin.resourceId, pageNumber: origin.page, path: dstuPath },
        }));
      }, delay);
    }
  }
}

/**
 * 聊天回答 → 笔记正文：引用标记离开会话即失效。
 * - [PDF@id:N] / [PDF@id:N-M] → 可点击回到原页的 pdfref:// 链接（笔记编辑器内置处理）
 * - [知识库-N] / [记忆-N] / [搜索-N] 等编号徽章 → 去掉（编号只在该次回答的来源面板中有意义；
 *   笔记本身已通过 origin 链回这条消息，可在对话里查看全部来源）
 */
export function chatCitationsToNoteMarkdown(
  text: string,
  pageLabel: (page: number) => string,
  helpers: { buildPdfRefHref: (sourceId: string, page: number) => string; createCitationPattern: () => RegExp },
): string {
  const pdf = /\[PDF@([a-zA-Z0-9_-]+):\s*(\d+)(?:[-,]\d+)*\]/gi;
  return text
    .replace(pdf, (_m, sourceId: string, page: string) => `[${pageLabel(Number(page))}](${helpers.buildPdfRefHref(sourceId, Number(page))})`)
    .replace(helpers.createCitationPattern(), '')
    .replace(/[ \t]+([，。；、,.;!?！？])/g, '$1');
}
