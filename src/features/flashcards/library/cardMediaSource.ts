/**
 * 卡片里的媒体出处 `[媒体@{resource_id}:{mm:ss}]`（docs/dev/media-learning §3）
 *
 * 由音视频转写制成的卡片，背面末尾会带讲到该知识点的时间锚点。卡片字段走模板渲染
 * （不经 Markdown），锚点原文既不可点也不好读：这里把第一个锚点解析出来，供卡片库与
 * 复习卡面的「▶ mm:ss」跳转按钮使用；复习卡面渲染前再把锚点原文去掉。
 */
import {
  findFirstMediaRef,
  MEDIA_REF_PATTERN_SOURCE,
  type MediaRefTarget,
} from '@/features/learning-hub/apps/views/media/mediaRefTime';
import type { ReviewCard } from '../store/fsrsReviewStore';

export type CardMediaSource = MediaRefTarget;

/** 依次扫描文本，返回第一个合法的媒体出处 */
export function findCardMediaSource(texts: Array<string | null | undefined>): CardMediaSource | null {
  return findFirstMediaRef(texts);
}

/** 行首的「出处：」标签连同锚点一起去掉；$1 保留行首分隔符 */
const LABELED_MEDIA_REF_RE = new RegExp(
  `(^|\\n|>)[ \\t]*(?:(?:出处|来源|依据|source)[ \\t]*[:：]?[ \\t]*)?${MEDIA_REF_PATTERN_SOURCE}`,
  'gi',
);
const ANY_MEDIA_REF_RE = new RegExp(MEDIA_REF_PATTERN_SOURCE, 'g');

/** 去掉文本里的媒体出处锚点，以及它留下的空段落与末尾空行 / <br> */
export function stripCardMediaSourceRefs(text: string): string {
  if (!text.includes('[媒体@')) return text;
  return text
    .replace(LABELED_MEDIA_REF_RE, '$1')
    .replace(ANY_MEDIA_REF_RE, '')
    .replace(/<(p|div|span)[^>]*>\s*<\/\1>/gi, '')
    .replace(/(?:\s|<br\s*\/?>|&nbsp;)+$/i, '');
}

/** 复习卡面用：各文本字段去掉媒体出处（编辑与卡片库保留原文） */
export function withoutCardMediaSourceRefs(card: ReviewCard): ReviewCard {
  return {
    ...card,
    front: stripCardMediaSourceRefs(card.front ?? ''),
    back: stripCardMediaSourceRefs(card.back ?? ''),
    text: typeof card.text === 'string' ? stripCardMediaSourceRefs(card.text) : card.text,
    extraFields: card.extraFields
      ? Object.fromEntries(Object.entries(card.extraFields).map(([key, value]) => [
        key,
        typeof value === 'string' ? stripCardMediaSourceRefs(value) : value,
      ]))
      : card.extraFields,
  };
}

/** 复习卡（camelCase 字段）的出处 */
export function findReviewCardMediaSource(card: ReviewCard | null | undefined): CardMediaSource | null {
  if (!card) return null;
  return findCardMediaSource(cardMediaSourceTexts({
    back: card.back,
    front: card.front,
    text: card.text,
    fields: card.extraFields,
  }));
}

/** 卡片的全部文本字段（背面优先：出处约定写在背面末尾） */
export function cardMediaSourceTexts(card: {
  back?: string | null;
  front?: string | null;
  text?: string | null;
  fields?: Record<string, string> | null;
  extra_fields?: Record<string, string> | null;
}): string[] {
  return [
    card.back ?? '',
    card.front ?? '',
    card.text ?? '',
    ...Object.values(card.fields ?? {}),
    ...Object.values(card.extra_fields ?? {}),
  ];
}
