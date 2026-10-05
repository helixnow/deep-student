/**
 * 卡片出处：卡片库行与复习会话共用的「查看来源」解析与跳转。
 *
 * 优先级：制卡来源笔记 / 资料页 > 音视频时间点 > 字段里残留的 [PDF@id:页] > 生成它的聊天会话。
 * 复习会话拿到的到期卡不带来源字段，按卡片 id 回查卡片库补齐。
 */
import { listAnkiLibraryCards } from '@/utils/chatApi';
import type { AnkiLibraryCard } from '@/types';
import { dispatchOpenMediaRef } from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import { cardMediaSourceTexts, findCardMediaSource, type CardMediaSource } from './library/cardMediaSource';

export interface CardSourceRef {
  kind?: string;
  id?: string;
  title?: string;
  page?: number;
}

export type CardSourceTarget =
  | { kind: 'ref'; ref: CardSourceRef }
  | { kind: 'media'; media: CardMediaSource }
  | { kind: 'chat'; sessionId: string };

const PDF_REF_IN_FIELD = /\[PDF@([A-Za-z0-9_-]+):\s*(\d+)/;
const LOOKUP_PAGE_SIZE = 200;
const LOOKUP_HINT_CHARS = 40;

/**
 * 打开制卡来源：笔记走 DSTU_OPEN_NOTE（source 非 Notes 自有 → Chat 侧契约：Workbench 下开进
 * Chat 画布；经典壳下卡片库不是聊天页，由 App 路由到学习资源页以标签打开，见
 * resolveClassicShellOpenNoteTarget），资料走 openResource（+ 跳页）
 */
export function openCardSourceRef(ref: CardSourceRef, source = 'flashcards-library'): void {
  if (!ref.id) return;
  if (ref.kind === 'note') {
    window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { detail: { noteId: ref.id, source } }));
    return;
  }
  void import('@/features/notes/noteOrigin').then(({ navigateToNoteOrigin }) =>
    navigateToNoteOrigin({ kind: 'resource', resourceId: ref.id!, page: ref.page, title: ref.title }));
}

/** 懒加载 workbench chat 入口，避免把整条聊天依赖链拉进闪卡视图。 */
export function jumpToChatSession(sessionId: string): void {
  void import('@/features/workbench/apps/chat/newSession')
    .then(({ openChatSession }) => {
      openChatSession(sessionId);
    })
    .catch(() => {
      // 跳转失败静默降级：来源信息本身仍在界面上展示
    });
}

type SourceFields = Pick<AnkiLibraryCard, 'sourceRef' | 'sourceSessionId' | 'sourceType' | 'sourceId'>;

/** 只看卡片自身能解析出的出处：来源引用、音视频锚点、字段里的 PDF 页码引用、生成会话。 */
export function resolveCardSource(
  card: Partial<SourceFields> | null | undefined,
  texts: Array<string | null | undefined>,
): CardSourceTarget | null {
  const ref = card?.sourceRef && typeof card.sourceRef.id === 'string' && card.sourceRef.id ? card.sourceRef : null;
  if (ref) return { kind: 'ref', ref };
  const media = findCardMediaSource(texts);
  if (media) return { kind: 'media', media };
  for (const text of texts) {
    const match = text ? PDF_REF_IN_FIELD.exec(text) : null;
    if (match) return { kind: 'ref', ref: { kind: 'resource', id: match[1], page: Number(match[2]) } };
  }
  const legacySessionId = card?.sourceType === 'chat_session' && typeof card.sourceId === 'string' ? card.sourceId.trim() : '';
  const sessionId = card?.sourceSessionId?.trim() || legacySessionId;
  return sessionId ? { kind: 'chat', sessionId } : null;
}

export function openCardSourceTarget(target: CardSourceTarget, source = 'flashcards-library'): void {
  if (target.kind === 'ref') openCardSourceRef(target.ref, source);
  else if (target.kind === 'media') dispatchOpenMediaRef(target.media.resourceId, target.media.seconds);
  else jumpToChatSession(target.sessionId);
}

/** 按卡片 id 回查卡片库（复用库的 LIKE 搜索 + 按 id 精确匹配；复习会话的到期卡不带来源字段）。 */
export async function findLibraryCard(cardId: string, hint: string): Promise<AnkiLibraryCard | null> {
  const search = hint.replace(/\s+/g, ' ').trim().slice(0, LOOKUP_HINT_CHARS);
  if (!cardId || !search) return null;
  const response = await listAnkiLibraryCards({ search, page: 1, page_size: LOOKUP_PAGE_SIZE });
  return response.items?.find((item) => item.id === cardId) ?? null;
}

export { cardMediaSourceTexts };
