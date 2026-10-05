/**
 * 字幕摘录（docs/dev/media-learning §3）：按时间窗 / 选中段取已完成的字幕，格式化为
 * `[mm:ss] 文本` 行，供「问刚才这段」、字幕划选引用 / 制卡、截帧附带上下文共用。
 *
 * 制卡材料与后端 `study_loop/media_source.rs`（chatanki 读媒体时用）同口径：~600 秒一片，
 * 片头带 `[媒体@id:起点]` 锚点，后续片附上一片末尾 3 段作「上文回顾」。切片 + 上文回顾 +
 * 一卡一事实的思路借鉴 BA7MLV/wangke-agent（src/pipelines/cards.ts，MIT License,
 * Copyright (c) 2026 BA7MLV）。
 */
import { buildMediaRefMarker, formatTranscriptClock } from './mediaRefTime';
import type { TranscriptSegment } from './mediaTranscriptApi';

/** 单次摘录的字数上限：防止把一整节课塞进输入框 */
export const TRANSCRIPT_EXCERPT_MAX_CHARS = 4000;
/** 「问刚才这段」回看的时长 */
export const RECENT_MOMENT_WINDOW_SECONDS = 60;
/** 截帧附带的上下文半径 */
export const FRAME_CONTEXT_RADIUS_SECONDS = 30;
/** 制卡材料每片覆盖的时长（与后端 MEDIA_CHUNK_SPAN_SECS 一致） */
export const MEDIA_CHUNK_SPAN_MS = 600_000;
const MEDIA_RECAP_LINES = 3;

/** 制卡附加要求（与后端 MEDIA_CARD_REQUIREMENTS 一致） */
export const MEDIA_CARD_REQUIREMENTS = [
  '材料来自音视频课程转写（每行 [mm:ss] 为该句开始时间，标题含 [媒体@资源ID:时间] 锚点）：',
  '- 每张卡背面末尾另起一行写出处 [媒体@资源ID:mm:ss]，资源 ID 取所在片段标题，时间取该知识点讲到的那一行（≥1 小时写 h:mm:ss），不得编造。',
  '- 一卡一事实；问题自包含，带上必要的课程语境，脱离视频也能看懂。',
  '- 只针对值得长期记忆的内容（定义、结论、公式、步骤、对比、易错点）；口头禅、寒暄、课程安排不制卡。',
  '- 「上文回顾」引用块只帮助理解语境，不要针对它制卡；跨片段重复讲到的知识点只制一张。',
].join('\n');

function usable(seg: TranscriptSegment): boolean {
  return seg.status === 'done' && seg.text.trim().length > 0;
}

function formatLine(seg: TranscriptSegment): string {
  return `[${formatTranscriptClock(seg.startMs)}] ${seg.text.trim()}`;
}

/** 与 [fromMs, toMs) 有交集的已完成字幕段（按时间顺序） */
export function segmentsInWindow(
  segments: readonly TranscriptSegment[],
  fromMs: number,
  toMs: number,
): TranscriptSegment[] {
  return segments
    .filter((seg) => usable(seg) && seg.endMs > fromMs && seg.startMs < toMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** 字幕段 → `[mm:ss] 文本` 行；超出上限时保留靠后的行（离「此刻」最近） */
export function formatTranscriptLines(
  segments: readonly TranscriptSegment[],
  maxChars = TRANSCRIPT_EXCERPT_MAX_CHARS,
): string {
  const lines = segments.filter(usable).map(formatLine);
  let total = 0;
  let start = lines.length;
  while (start > 0 && total + lines[start - 1].length <= maxChars) {
    start -= 1;
    total += lines[start].length + 1;
  }
  if (start === lines.length && lines.length > 0) start = lines.length - 1;
  return lines.slice(start).join('\n');
}

export interface TranscriptQuote {
  /** 第一段的起点（秒） */
  startSeconds: number;
  /** `[媒体@id:mm:ss]` 锚点（第一段起点） */
  marker: string;
  /** `> [mm:ss] 文本` 引用块 */
  quote: string;
}

/** 选中 / 时间窗内的字幕 → 带锚点的引用块；没有可用字幕时为 null */
export function buildTranscriptQuote(
  resourceId: string,
  segments: readonly TranscriptSegment[],
): TranscriptQuote | null {
  const ordered = segments.filter(usable).sort((a, b) => a.startMs - b.startMs);
  const lines = formatTranscriptLines(ordered);
  if (!lines) return null;
  const startSeconds = Math.floor(ordered[0].startMs / 1000);
  return {
    startSeconds,
    marker: buildMediaRefMarker(resourceId, startSeconds),
    quote: lines.split('\n').map((line) => `> ${line}`).join('\n'),
  };
}

/**
 * 字幕段 → 制卡 / 出题材料：~600 秒一片，片头带锚点，后续片附「上文回顾」。
 * 没有可用字幕时返回空串。
 */
export function buildMediaGenerationMaterial(
  resourceId: string,
  segments: readonly TranscriptSegment[],
): string {
  const ordered = segments.filter(usable).sort((a, b) => a.startMs - b.startMs);
  const chunks: Array<{ startMs: number; lines: string[] }> = [];
  for (const seg of ordered) {
    const last = chunks[chunks.length - 1];
    if (!last || seg.startMs >= last.startMs + MEDIA_CHUNK_SPAN_MS) {
      chunks.push({ startMs: seg.startMs, lines: [] });
    }
    chunks[chunks.length - 1].lines.push(formatLine(seg));
  }
  return chunks
    .map((chunk, i) => {
      const parts = [
        `## 片段 ${i + 1}/${chunks.length} · ${buildMediaRefMarker(resourceId, Math.floor(chunk.startMs / 1000))} 起`,
      ];
      if (i > 0) {
        const recap = chunks[i - 1].lines.slice(-MEDIA_RECAP_LINES);
        parts.push('> 上文回顾（仅帮助理解语境，不要针对它制卡/出题）：', ...recap.map((line) => `> ${line}`));
      }
      parts.push(...chunk.lines);
      return parts.join('\n');
    })
    .join('\n\n');
}
