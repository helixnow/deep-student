/**
 * 媒体时间戳格式（契约 docs/dev/media-learning/README.md §2）
 *
 * `[媒体@{resource_id}:{mm:ss}]`，≥ 1 小时用 `h:mm:ss`。与讲义 IR
 * （features/media-handout/ir.ts formatClock）同一格式：分钟两位补零。
 */

/** 秒 → `mm:ss`（≥ 1 小时为 `h:mm:ss`），向下取整到秒 */
export function formatMediaRefTimestamp(totalSeconds: number): string {
  const sec = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * `mm:ss` / `h:mm:ss`（容忍 `[…]` 包裹、空白与超 59 的分钟数）→ 秒。
 * 秒位必须 < 60；非法返回 null。
 */
export function parseMediaRefTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^\[|\]$/g, '').trim();
  if (!/^\d{1,3}(?::\d{1,3}){1,2}$/.test(trimmed)) return null;
  const parts = trimmed.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const secs = parts[parts.length - 1];
  if (secs >= 60) return null;
  if (parts.length === 3) {
    if (parts[1] >= 60) return null;
    return parts[0] * 3600 + parts[1] * 60 + secs;
  }
  return parts[0] * 60 + secs;
}

/** `[媒体@{resource_id}:{mm:ss}]` 的正则源（组 1 资源 id，组 2 时间） */
export const MEDIA_REF_PATTERN_SOURCE = String.raw`\[媒体@([^\s:\]]+):(\d{1,3}(?::\d{1,3}){1,2})\]`;

export interface MediaRefTarget {
  resourceId: string;
  seconds: number;
  /** 原文时间标签（mm:ss / h:mm:ss） */
  label: string;
}

/** 依次扫描文本，返回第一个合法的媒体引用 */
export function findFirstMediaRef(texts: Array<string | null | undefined>): MediaRefTarget | null {
  for (const text of texts) {
    if (!text) continue;
    const re = new RegExp(MEDIA_REF_PATTERN_SOURCE, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const seconds = parseMediaRefTimestamp(match[2]);
      if (seconds !== null) return { resourceId: match[1], seconds, label: match[2] };
    }
  }
  return null;
}

/** 构造引用标记文本：`[媒体@file_x:12:34]` */
export function buildMediaRefMarker(resourceId: string, seconds: number): string {
  return `[媒体@${resourceId}:${formatMediaRefTimestamp(seconds)}]`;
}

/** 毫秒 → 字幕面板时间标签（与引用同格式，便于用户复制成引用） */
export function formatTranscriptClock(ms: number): string {
  return formatMediaRefTimestamp(ms / 1000);
}
