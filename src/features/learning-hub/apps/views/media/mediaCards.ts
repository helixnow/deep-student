/**
 * 音视频直接制卡（不开聊天）：字幕 → 带锚点的切片材料 → CardForge 后台任务（任务台跟踪）。
 * 卡片来源记为该媒体资源（卡片库 / 本课台账按 source_ref.id 归集），背面出处可回看。
 */
import type { TranscriptSegment } from './mediaTranscriptApi';
import { buildMediaGenerationMaterial, MEDIA_CARD_REQUIREMENTS } from './transcriptExcerpt';

export interface MakeMediaCardsInput {
  resourceId: string;
  fileName: string;
  segments: readonly TranscriptSegment[];
  /** 追加在出处要求之后的要求（如「只针对选中的片段」） */
  extraRequirements?: string;
  maxCards?: number;
  t: (key: string) => string;
}

/** 课名（去扩展名）作子牌组名：「音视频::第 3 讲 正则化」 */
export function mediaDeckName(base: string, fileName: string): string {
  const title = (fileName.replace(/\.[^.]+$/, '') || fileName).replace(/::/g, ' ').trim();
  return title ? `${base}::${title}` : base;
}

export async function makeMediaCards(input: MakeMediaCardsInput): Promise<boolean> {
  const { t } = input;
  const content = buildMediaGenerationMaterial(input.resourceId, input.segments);
  const { generateCardsFromText } = await import('@/features/anki/generateCardsFromText');
  const result = await generateCardsFromText({
    content,
    sourceRef: { kind: 'resource', id: input.resourceId, title: input.fileName },
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
