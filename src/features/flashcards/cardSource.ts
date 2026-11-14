/**
 * 卡片出处：卡片库行与复习会话共用的「查看来源」解析与跳转。
 *
 * 优先级：语义锚点 URI (`ds-anchor://v1/...`) > 制卡来源笔记 / 资料页 > 音视频时间点 >
 * 字段里残留的 [PDF@id:页] > 生成它的聊天会话。
 * 复习会话拿到的到期卡不带来源字段时，按卡片 id 回查卡片库补齐。
 */
import { listAnkiLibraryCards } from '@/utils/chatApi';
import type { AnkiLibraryCard } from '@/types';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  formatAnchorShortLocator,
  isSemanticAnchorUri,
  parseSemanticAnchor,
  serializeSemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import { dispatchOpenMediaRef } from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import { cardMediaSourceTexts, findCardMediaSource, type CardMediaSource } from './library/cardMediaSource';

export interface CardSourceRef {
  kind?: string;
  id?: string;
  title?: string;
  page?: number;
  quote?: string;
  anchorUri?: string;
  locatorLabel?: string;
}

export type CardSourceTarget =
  | { kind: 'anchor'; anchorUri: string; locatorLabel: string }
  | { kind: 'ref'; ref: CardSourceRef }
  | { kind: 'media'; media: CardMediaSource }
  | { kind: 'chat'; sessionId: string };

const PDF_REF_IN_FIELD = /\[PDF@([A-Za-z0-9_-]+):\s*(\d+)/;
const LOOKUP_PAGE_SIZE = 200;
const LOOKUP_HINT_CHARS = 40;

/**
 * 打开制卡来源：语义锚点直接走 `kernel.anchors.reveal`；笔记走 DSTU_OPEN_NOTE；资料走 openResource（+ 跳页）
 */
export function openCardSourceRef(ref: CardSourceRef, source = 'flashcards-library'): void {
  if (ref.kind === 'anchor' && ref.anchorUri && isSemanticAnchorUri(ref.anchorUri)) {
    void getAppKernel().anchors.reveal(ref.anchorUri, { splitIfClosed: true, pulse: true });
    return;
  }
  if (!ref.id) return;
  if (isSemanticAnchorUri(ref.id)) {
    void getAppKernel().anchors.reveal(ref.id, { splitIfClosed: true, pulse: true });
    return;
  }
  if (ref.kind === 'note') {
    window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { detail: { noteId: ref.id, source } }));
    return;
  }
  void import('@/features/notes/noteOrigin').then(({ navigateToNoteOrigin }) =>
    navigateToNoteOrigin({ kind: 'resource', resourceId: ref.id!, page: ref.page, title: ref.title, quote: ref.quote }));
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

export interface CardSourceInput {
  sourceRef?: AnkiLibraryCard['sourceRef'] | string | null;
  source_ref?: string | null;
  sourceSessionId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  extraFields?: Record<string, string> | null;
  extra_fields?: Record<string, string> | null;
  fields?: Record<string, string> | null;
}

function extractSemanticAnchorCandidate(card: Partial<CardSourceInput> | null | undefined): string | null {
  if (!card) return null;
  const candidates: Array<unknown> = [
    card.extraFields?._source_anchor,
    card.extra_fields?._source_anchor,
    card.fields?._source_anchor,
    typeof card.source_ref === 'string' ? card.source_ref : undefined,
    typeof card.sourceRef === 'string' ? card.sourceRef : undefined,
    card.sourceRef && typeof card.sourceRef === 'object'
      ? (card.sourceRef as CardSourceRef).anchorUri ?? card.sourceRef.id
      : undefined,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (isSemanticAnchorUri(trimmed)) return trimmed;
  }
  return null;
}

/** 只看卡片自身能解析出的出处：语义锚点 URI、来源引用、音视频锚点、字段里的 PDF 页码引用、生成会话。 */
export function resolveCardSource(
  card: Partial<CardSourceInput> | null | undefined,
  texts: Array<string | null | undefined> = [],
): CardSourceTarget | null {
  const anchorCandidate = extractSemanticAnchorCandidate(card);
  if (anchorCandidate) {
    const parsed = parseSemanticAnchor(anchorCandidate);
    if (parsed) {
      return {
        kind: 'anchor',
        anchorUri: serializeSemanticAnchor(parsed),
        locatorLabel: formatAnchorShortLocator(parsed),
      };
    }
  }

  const refObj = card?.sourceRef && typeof card.sourceRef === 'object' ? card.sourceRef : null;
  const ref = refObj && typeof refObj.id === 'string' && refObj.id ? refObj : null;
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

export function openCardSourceTarget(
  target: CardSourceTarget,
  source = 'flashcards-library',
): Promise<void> | void {
  if (target.kind === 'anchor') {
    return getAppKernel()
      .anchors.reveal(target.anchorUri, { splitIfClosed: true, pulse: true })
      .then(() => undefined);
  }
  if (target.kind === 'ref') openCardSourceRef(target.ref, source);
  else if (target.kind === 'media') dispatchOpenMediaRef(target.media.resourceId, target.media.seconds);
  else jumpToChatSession(target.sessionId);
}

/** 按卡片 id 回查卡片库（复用库的 LIKE 搜索 + 按 id 精确匹配；复习会话的到期卡不带来源字段）。 */
export async function findLibraryCard(cardId: string, hint: string): Promise<AnkiLibraryCard | null> {
  const search = hint.replace(/\s+/g, ' ').trim().slice(0, LOOKUP_PAGE_SIZE);
  const trimmedHint = search.slice(0, LOOKUP_HINT_CHARS);
  if (!cardId || !trimmedHint) return null;
  const response = await listAnkiLibraryCards({ search: trimmedHint, page: 1, page_size: LOOKUP_PAGE_SIZE });
  return response.items?.find((item) => item.id === cardId) ?? null;
}

export { cardMediaSourceTexts };
