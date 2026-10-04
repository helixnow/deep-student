/**
 * 卡片里的媒体出处 `[媒体@{resource_id}:{mm:ss}]`（docs/dev/media-learning §3）
 *
 * 由音视频转写制成的卡片，背面末尾会带讲到该知识点的时间锚点。卡片字段走模板渲染
 * （不经 Markdown），这里只把第一个锚点解析出来，供卡片库「▶ mm:ss」跳转按钮使用。
 */
import { parseMediaRefTimestamp } from '@/features/learning-hub/apps/views/media/mediaRefTime';

export interface CardMediaSource {
  resourceId: string;
  seconds: number;
  /** 原文时间标签（mm:ss / h:mm:ss） */
  label: string;
}

const MEDIA_REF_RE = /\[媒体@([^\s:\]]+):(\d{1,3}(?::\d{1,3}){1,2})\]/;

/** 依次扫描文本，返回第一个合法的媒体出处 */
export function findCardMediaSource(texts: Array<string | null | undefined>): CardMediaSource | null {
  for (const text of texts) {
    if (!text) continue;
    const re = new RegExp(MEDIA_REF_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const seconds = parseMediaRefTimestamp(match[2]);
      if (seconds !== null) return { resourceId: match[1], seconds, label: match[2] };
    }
  }
  return null;
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
