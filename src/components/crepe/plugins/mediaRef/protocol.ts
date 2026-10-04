/**
 * 笔记内媒体时间戳回链（docs/dev/media-learning §2 / §3 讲义锚点）
 *
 * 两种写法都可点击跳转：
 * 1. 纯文本标记 `[媒体@file_xxx:12:34]`（与聊天引用同格式，讲义小节锚点）——
 *    由装饰插件识别并加可点击样式；
 * 2. markdown 链接 `[12:34](mediaref://file_xxx?t=754)`（可自定义链接文字）。
 *
 * 点击派发既有的 `media-ref:open`（经典壳 useChatPageEvents / 工作台
 * WorkbenchEventBridge 打开资源并经 media-ref:focus 跳到该时间）。
 */

import { parseMediaRefTimestamp } from '@/features/learning-hub/apps/views/media/mediaRefTime';

export const MEDIA_REF_HREF_PROTOCOL = 'mediaref://';

export interface MediaRefTarget {
  resourceId: string;
  seconds: number;
}

export function buildMediaRefHref(resourceId: string, seconds: number): string {
  return `${MEDIA_REF_HREF_PROTOCOL}${encodeURIComponent(resourceId)}?t=${Math.max(0, Math.floor(seconds))}`;
}

/** `mediaref://id?t=754`（t 也接受 `12:34`）；缺 t 或非法返回 null */
export function parseMediaRefHref(href: string | null | undefined): MediaRefTarget | null {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith(MEDIA_REF_HREF_PROTOCOL)) return null;
  const rest = trimmed.slice(MEDIA_REF_HREF_PROTOCOL.length);
  const queryIndex = rest.search(/[?#]/);
  const rawId = (queryIndex >= 0 ? rest.slice(0, queryIndex) : rest).trim();
  if (!rawId) return null;
  let resourceId = rawId;
  try {
    resourceId = decodeURIComponent(rawId);
  } catch {
    /* 尽力解码 */
  }
  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : '';
  const tMatch = /(?:^|[?&#])t=([^&#]+)/.exec(query);
  if (!tMatch) return null;
  let raw = tMatch[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* 保留原文 */
  }
  const seconds = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : parseMediaRefTimestamp(raw);
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  return { resourceId, seconds };
}

/** 与聊天 citationRemarkPlugin 的 MEDIA_REF_PATTERN 同一格式 */
const MEDIA_REF_TEXT_PATTERN = /\[(?:媒体|media)@([a-zA-Z0-9_-]+):\s*(\d{1,3}(?::\d{1,3}){1,2})\]/gi;

export interface MediaRefTextMatch extends MediaRefTarget {
  from: number;
  to: number;
}

/** 在一段纯文本中找出全部 `[媒体@id:mm:ss]` 标记（offset 相对该文本） */
export function findMediaRefMarkers(text: string): MediaRefTextMatch[] {
  if (!text || !/(媒体|media)@/i.test(text)) return [];
  const out: MediaRefTextMatch[] = [];
  MEDIA_REF_TEXT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MEDIA_REF_TEXT_PATTERN.exec(text)) !== null) {
    const seconds = parseMediaRefTimestamp(match[2]);
    if (seconds === null) continue;
    out.push({
      resourceId: match[1],
      seconds,
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return out;
}
