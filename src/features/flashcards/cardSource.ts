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
import {
  dispatchOpenMediaRef,
  rememberPendingMediaFocus,
} from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import {
  formatMediaRefTimestamp,
  parseMediaRefTimestamp,
} from '@/features/learning-hub/apps/views/media/mediaRefTime';
import { cardMediaSourceTexts, findCardMediaSource, type CardMediaSource } from './library/cardMediaSource';

export interface CardSourceRef {
  kind?: string;
  id?: string;
  title?: string;
  page?: number;
  quote?: string;
  anchorUri?: string;
  locatorLabel?: string;
  startMs?: number;
  seconds?: number;
}

export type CardSourceTarget =
  | { kind: 'anchor'; anchorUri: string; locatorLabel: string }
  | { kind: 'ref'; ref: CardSourceRef }
  | { kind: 'media'; media: CardMediaSource }
  | { kind: 'chat'; sessionId: string };

const PDF_REF_IN_FIELD = /\[PDF@([A-Za-z0-9_-]+):\s*(\d+)/;
const MEDIA_REF_ALT_RE = /\[(?:媒体|media)@([^\s:\]]+):(\d{1,3}(?::\d{1,3}){1,2})\]/gi;
const BRACKET_TIMESTAMP_RE = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;
const MEDIA_FILE_EXT_RE = /\.(?:mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|opus|flac|aac|bilibili)$/i;
const LOOKUP_PAGE_SIZE = 200;
const LOOKUP_HINT_CHARS = 40;

function mediaSourceFromSemanticAnchor(anchorUri: string): CardMediaSource | null {
  const parsed = parseSemanticAnchor(anchorUri);
  if (!parsed || parsed.kind !== 'media') return null;
  const seconds = Math.max(0, parsed.startMs / 1000);
  return {
    resourceId: parsed.resourceId,
    seconds,
    label: formatMediaRefTimestamp(seconds),
  };
}

function findMediaRefInTexts(texts: Array<string | null | undefined>): CardMediaSource | null {
  const canonical = findCardMediaSource(texts);
  if (canonical) return canonical;
  for (const text of texts) {
    if (!text) continue;
    MEDIA_REF_ALT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MEDIA_REF_ALT_RE.exec(text)) !== null) {
      const seconds = parseMediaRefTimestamp(match[2]);
      if (seconds !== null) {
        return { resourceId: match[1], seconds, label: formatMediaRefTimestamp(seconds) };
      }
    }
  }
  return null;
}

function isMediaResourceRef(ref: CardSourceRef): boolean {
  if (ref.kind === 'media') return true;
  if (typeof ref.anchorUri === 'string') {
    const parsed = parseSemanticAnchor(ref.anchorUri.trim());
    if (parsed?.kind === 'media') return true;
  }
  if (typeof ref.title === 'string' && MEDIA_FILE_EXT_RE.test(ref.title.trim())) return true;
  return false;
}

function findMediaSourceFromRef(
  ref: CardSourceRef,
  texts: Array<string | null | undefined> = [],
): CardMediaSource | null {
  if (typeof ref.anchorUri === 'string') {
    const fromUri = mediaSourceFromSemanticAnchor(ref.anchorUri.trim());
    if (fromUri) return fromUri;
  }
  if (typeof ref.id === 'string' && isSemanticAnchorUri(ref.id.trim())) {
    const fromId = mediaSourceFromSemanticAnchor(ref.id.trim());
    if (fromId) return fromId;
  }
  const resourceId = typeof ref.id === 'string' ? ref.id.trim() : '';
  if (!resourceId) return null;
  if (typeof ref.startMs === 'number' && Number.isFinite(ref.startMs) && ref.startMs >= 0) {
    const seconds = ref.startMs / 1000;
    return { resourceId, seconds, label: formatMediaRefTimestamp(seconds) };
  }
  if (typeof ref.seconds === 'number' && Number.isFinite(ref.seconds) && ref.seconds >= 0) {
    return { resourceId, seconds: ref.seconds, label: formatMediaRefTimestamp(ref.seconds) };
  }
  if (isMediaResourceRef(ref)) {
    for (const text of [ref.quote, ...texts]) {
      if (!text) continue;
      BRACKET_TIMESTAMP_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = BRACKET_TIMESTAMP_RE.exec(text)) !== null) {
        const seconds = parseMediaRefTimestamp(match[1]);
        if (seconds !== null) {
          return { resourceId, seconds, label: formatMediaRefTimestamp(seconds) };
        }
      }
    }
  }
  return null;
}

function openSemanticAnchorUri(anchorUri: string): Promise<void> {
  const parsed = parseSemanticAnchor(anchorUri);
  if (parsed?.kind === 'media') {
    // Remember pending focus before reveal so cold-opening Media Studio / Workbench File
    // window still seeks and highlights even if the 1500ms anchor waiter times out.
    rememberPendingMediaFocus?.(parsed.resourceId, parsed.startMs / 1000);
  }
  return getAppKernel()
    .anchors.reveal(anchorUri, { splitIfClosed: true, pulse: true })
    .then(() => undefined);
}

/**
 * 打开制卡来源：语义锚点直接走 `kernel.anchors.reveal`；音视频时间戳走 `media-ref:open`；
 * 笔记走 DSTU_OPEN_NOTE；资料走 openResource（+ 跳页）。
 */
export function openCardSourceRef(ref: CardSourceRef, source = 'flashcards-library'): void {
  if (ref.anchorUri && isSemanticAnchorUri(ref.anchorUri)) {
    void openSemanticAnchorUri(ref.anchorUri);
    return;
  }
  if (!ref.id) return;
  if (isSemanticAnchorUri(ref.id)) {
    void openSemanticAnchorUri(ref.id);
    return;
  }
  const refMedia = findMediaSourceFromRef(ref);
  if (refMedia) {
    dispatchOpenMediaRef(refMedia.resourceId, refMedia.seconds);
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
  sourceRef?: AnkiLibraryCard['sourceRef'] | CardSourceRef | string | null;
  source_ref?: string | null;
  sourceSessionId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  extraFields?: Record<string, string> | null;
  extra_fields?: Record<string, string> | null;
  fields?: Record<string, string> | null;
}

function extractPerCardSemanticAnchorCandidate(card: Partial<CardSourceInput> | null | undefined): string | null {
  if (!card) return null;
  const refObj = card.sourceRef && typeof card.sourceRef === 'object' ? (card.sourceRef as CardSourceRef) : null;
  const candidates: Array<unknown> = [
    card.extraFields?._source_anchor,
    card.extra_fields?._source_anchor,
    card.fields?._source_anchor,
    typeof card.source_ref === 'string' ? card.source_ref : undefined,
    typeof card.sourceRef === 'string' ? card.sourceRef : undefined,
    refObj?.id,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (isSemanticAnchorUri(trimmed)) return trimmed;
  }
  return null;
}

/**
 * 解析卡片关联的音视频时间戳出处（供「▶ mm:ss」徽标与跳转共用）：
 * 单卡 `_source_anchor` > 单卡正背面 `[媒体@id:mm:ss]` > `sourceRef.anchorUri` / `startMs` / `seconds` / 媒体 `[mm:ss]`。
 */
export function resolveCardMediaSource(
  card: Partial<CardSourceInput> | null | undefined,
  texts: Array<string | null | undefined> = [],
): CardMediaSource | null {
  const perCardAnchor = extractPerCardSemanticAnchorCandidate(card);
  if (perCardAnchor) {
    const fromAnchor = mediaSourceFromSemanticAnchor(perCardAnchor);
    if (fromAnchor) return fromAnchor;
  }
  const fromTexts = findMediaRefInTexts(texts);
  if (fromTexts) return fromTexts;
  const refObj = card?.sourceRef && typeof card.sourceRef === 'object' ? (card.sourceRef as CardSourceRef) : null;
  if (refObj) {
    const fromRef = findMediaSourceFromRef(refObj, texts);
    if (fromRef) return fromRef;
  }
  return null;
}

/** 只看卡片自身能解析出的出处：单卡语义锚点 URI、笔记/带页码资料、音视频时间点、纯资料引用、PDF 页码引用、生成会话。 */
export function resolveCardSource(
  card: Partial<CardSourceInput> | null | undefined,
  texts: Array<string | null | undefined> = [],
): CardSourceTarget | null {
  const anchorCandidate = extractPerCardSemanticAnchorCandidate(card);
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

  const refObj = card?.sourceRef && typeof card.sourceRef === 'object' ? (card.sourceRef as CardSourceRef) : null;
  const refAnchor = refObj?.anchorUri ? parseSemanticAnchor(refObj.anchorUri.trim()) : null;
  if (refAnchor && refAnchor.kind !== 'media') {
    return {
      kind: 'anchor',
      anchorUri: serializeSemanticAnchor(refAnchor),
      locatorLabel: formatAnchorShortLocator(refAnchor),
    };
  }

  const ref = refObj && typeof refObj.id === 'string' && refObj.id ? refObj : null;
  if (ref && (ref.kind === 'note' || (typeof ref.page === 'number' && Number.isFinite(ref.page) && ref.page > 0))) {
    return { kind: 'ref', ref };
  }

  // Per-card media timestamp (`[媒体@id:00:13]`) takes precedence over bare resource `sourceRef`
  // AND over batch-level media `sourceRef.anchorUri` so whole-lecture cards jump to their own cue.
  const mediaFromTexts = findMediaRefInTexts(texts);
  if (mediaFromTexts) return { kind: 'media', media: mediaFromTexts };

  if (refAnchor && refAnchor.kind === 'media') {
    return {
      kind: 'anchor',
      anchorUri: serializeSemanticAnchor(refAnchor),
      locatorLabel: formatAnchorShortLocator(refAnchor),
    };
  }
  if (ref) {
    const mediaFromRef = findMediaSourceFromRef(ref, texts);
    if (mediaFromRef) return { kind: 'media', media: mediaFromRef };
    return { kind: 'ref', ref };
  }

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
    return openSemanticAnchorUri(target.anchorUri);
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
