/**
 * 音视频直接制卡（不开聊天）：字幕 → 带锚点的切片材料 → CardForge 后台任务（任务台跟踪）。
 * 卡片来源记为该媒体资源（卡片库 / 本课台账按 source_ref.id 归集），同时确定性写入
 * 媒体语义锚点与起始时间戳（anchorUri / startMs / seconds），即使模型漏写背面 `[媒体@id:mm:ss]`
 * 也能完整保留「▶ mm:ss」徽标与精确跳转。
 */
import { serializeSemanticAnchor } from '@/ui-kernel/contracts/interop';
import { buildMediaSemanticAnchor } from './mediaInteropBridge';
import { formatMediaRefTimestamp } from './mediaRefTime';
import type { TranscriptSegment } from './mediaTranscriptApi';
import { buildMediaGenerationMaterial, MEDIA_CARD_REQUIREMENTS } from './transcriptExcerpt';

export interface MakeMediaCardsInput {
  resourceId: string;
  aliasResourceId?: string;
  fileName: string;
  segments: readonly TranscriptSegment[];
  /** 追加在出处要求之后的要求（如「只针对选中的片段」） */
  extraRequirements?: string;
  maxCards?: number;
  t: (key: string) => string;
}

export interface MediaCardSourceRef {
  kind: 'resource';
  id: string;
  title: string;
  quote?: string;
  anchorUri?: string;
  startMs?: number;
  seconds?: number;
  locatorLabel?: string;
}

/** 课名（去扩展名）作子牌组名：「音视频::第 3 讲 正则化」 */
export function mediaDeckName(base: string, fileName: string): string {
  const title = (fileName.replace(/\.[^.]+$/, '') || fileName).replace(/::/g, ' ').trim();
  return title ? `${base}::${title}` : base;
}

/**
 * 构造音视频制卡的确定性来源引用：保留 `kind: 'resource'` 与原始 `id` 供本课台账按
 * `$.source_ref.id` 归集，同时附带最早可用字幕段的 `ds-anchor://v1/media/...` 与毫秒/秒坐标。
 */
export function buildMediaCardSourceRef(input: {
  resourceId: string;
  aliasResourceId?: string;
  fileName: string;
  segments: readonly TranscriptSegment[];
}): MediaCardSourceRef {
  const ordered = input.segments
    .filter((seg) => seg.status === 'done' && seg.text.trim().length > 0)
    .sort((a, b) => a.startMs - b.startMs);
  const anchorSeg = ordered[0] ?? [...input.segments].sort((a, b) => a.startMs - b.startMs)[0];
  if (!anchorSeg || !Number.isFinite(anchorSeg.startMs)) {
    return { kind: 'resource', id: input.resourceId, title: input.fileName };
  }
  const startMs = Math.max(0, Math.round(anchorSeg.startMs));
  const endMs = Number.isFinite(anchorSeg.endMs)
    ? Math.max(startMs, Math.round(anchorSeg.endMs))
    : undefined;
  const seconds = Math.floor(startMs / 1000);
  const quote = anchorSeg.text.trim().slice(0, 160) || undefined;
  let anchorUri: string | undefined;
  try {
    anchorUri = serializeSemanticAnchor(
      buildMediaSemanticAnchor({
        resourceId: input.resourceId,
        aliasResourceId: input.aliasResourceId,
        startMs,
        endMs,
        quote,
        mediaTitle: input.fileName,
      }),
    );
  } catch {
    anchorUri = undefined;
  }
  return {
    kind: 'resource',
    id: input.resourceId,
    title: input.fileName,
    ...(quote ? { quote } : {}),
    ...(anchorUri ? { anchorUri } : {}),
    startMs,
    seconds,
    locatorLabel: formatMediaRefTimestamp(seconds),
  };
}

export async function makeMediaCards(input: MakeMediaCardsInput): Promise<boolean> {
  const { t } = input;
  const content = buildMediaGenerationMaterial(input.resourceId, input.segments);
  const sourceRef = buildMediaCardSourceRef({
    resourceId: input.resourceId,
    aliasResourceId: input.aliasResourceId,
    fileName: input.fileName,
    segments: input.segments,
  });
  const { generateCardsFromText } = await import('@/features/anki/generateCardsFromText');
  const result = await generateCardsFromText({
    content,
    sourceRef,
    deckName: mediaDeckName(t('learningHub:mediaCards.deckName'), input.fileName),
    requirements: [MEDIA_CARD_REQUIREMENTS, input.extraRequirements].filter(Boolean).join('\n'),
    maxCards: input.maxCards,
    messages: {
      tooShort: t('learningHub:mediaCards.tooShort'),
      started: t('learningHub:mediaCards.started'),
      failed: t('learningHub:mediaCards.failed'),
      openTaskDashboard: t('learningHub:mediaCards.openTaskDashboard'),
    },
  });
  return result.ok;
}
