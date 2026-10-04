/**
 * 讲义流水线的纯逻辑部分：字幕格式化、长文分块、大纲解析、分节时间窗。
 * 全部无副作用，便于单测。
 */
import { extractJsonObject, formatClock, parseClock } from './ir';

export interface TranscriptSegment {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  /** 0 待转写 / 1 完成 / 2 失败（契约 §1.1） */
  status: number;
}

export interface HandoutFrame {
  /** 采样时间（整数秒） */
  ts: number;
  width: number;
  height: number;
  blob: Blob;
  caption: string;
  /** VLM 判定为教学画面（课件/板书/图表/代码） */
  isTeaching: boolean;
}

export interface OutlineSection {
  heading: string;
  startSec: number;
  endSec: number;
  points: string[];
}

export interface Outline {
  title: string;
  summary: string;
  sections: OutlineSection[];
}

export const CHUNK_CHARS = 6000;
/** 超过该长度先分块摘要再出大纲 */
export const DIRECT_OUTLINE_MAX_CHARS = 12000;
export const MAX_SECTIONS = 12;
export const TRANSCRIPT_WINDOW_PAD_SEC = 5;
export const FRAME_WINDOW_PAD_SEC = 10;

/** 只保留完成且有文本的段，按时间排序 */
export function usableSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .filter((s) => s.status === 1 && s.text.trim().length > 0)
    .sort((a, b) => a.startMs - b.startMs);
}

export function segmentsToTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${formatClock(s.startMs / 1000)}] ${s.text.trim()}`).join('\n');
}

/**
 * 按行切块（每块 ≤ maxChars，不切断单行；超长单行硬切）。
 * 行首带时间戳，块边界落在行边界上可保住每块的时间信息。
 */
export function chunkTranscript(transcript: string, maxChars = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const line of transcript.split('\n')) {
    if (line.length > maxChars) {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
      continue;
    }
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > maxChars) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 解析并规整大纲 JSON：
 * - 丢弃无标题/无法解析时间的节；时间按起点排序；end < start 时取下一节起点或媒体末尾；
 * - 截断到 MAX_SECTIONS；全空时抛错。
 */
export function parseOutline(raw: string, durationSec: number, fallbackTitle: string): Outline {
  const obj = extractJsonObject<{
    title?: unknown;
    summary?: unknown;
    sections?: Array<Record<string, unknown>>;
  }>(raw);
  if (!Array.isArray(obj.sections)) throw new Error('outline: missing sections');

  const parsed: OutlineSection[] = [];
  for (const s of obj.sections) {
    const heading = typeof s?.heading === 'string' ? s.heading.trim() : '';
    const startSec = parseClock(s?.start);
    if (!heading || startSec === null) continue;
    const endSec = parseClock(s?.end);
    const points = Array.isArray(s?.points)
      ? (s.points as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : [];
    parsed.push({ heading, startSec, endSec: endSec ?? -1, points });
  }
  if (parsed.length === 0) throw new Error('outline: no valid sections');

  parsed.sort((a, b) => a.startSec - b.startSec);
  const sections = parsed.slice(0, MAX_SECTIONS);
  const end = durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
  sections.forEach((s, i) => {
    const nextStart = sections[i + 1]?.startSec;
    if (s.endSec < s.startSec) s.endSec = nextStart ?? (Number.isFinite(end) ? end : s.startSec);
    // 被截断时最后一节吞下剩余时间，保证内容不丢
    if (i === sections.length - 1 && parsed.length > sections.length && Number.isFinite(end)) {
      s.endSec = Math.max(s.endSec, end);
    }
  });

  return {
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : fallbackTitle,
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
    sections,
  };
}

/** 本节字幕窗口：段起点落在 [start-5s, end+5s] */
export function sectionTranscriptWindow(
  segments: TranscriptSegment[],
  section: Pick<OutlineSection, 'startSec' | 'endSec'>,
  padSec = TRANSCRIPT_WINDOW_PAD_SEC,
): TranscriptSegment[] {
  const lo = (section.startSec - padSec) * 1000;
  const hi = (section.endSec + padSec) * 1000;
  return segments.filter((s) => s.startMs >= lo && s.startMs <= hi);
}

/** 本节配图窗口：帧时间落在 [start-10s, end+10s] 且为教学画面 */
export function sectionFrameWindow<F extends Pick<HandoutFrame, 'ts' | 'isTeaching'>>(
  frames: F[],
  section: Pick<OutlineSection, 'startSec' | 'endSec'>,
  padSec = FRAME_WINDOW_PAD_SEC,
): F[] {
  return frames.filter(
    (f) => f.isTeaching && f.ts >= section.startSec - padSec && f.ts <= section.endSec + padSec,
  );
}

/** figure 合法时间范围与配图清单一致（±10 s 容差） */
export function sectionFigureRange(section: Pick<OutlineSection, 'startSec' | 'endSec'>) {
  return {
    startSec: Math.max(0, section.startSec - FRAME_WINDOW_PAD_SEC),
    endSec: section.endSec + FRAME_WINDOW_PAD_SEC,
  };
}

/** 把模型给出的 figure 时间吸附到最近的已抽帧（≤ toleranceSec），否则 null */
export function snapToFrame<F extends Pick<HandoutFrame, 'ts'>>(
  ts: number,
  frames: F[],
  toleranceSec = 3,
): F | null {
  let best: F | null = null;
  let bestD = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.ts - ts);
    if (d < bestD) {
      best = f;
      bestD = d;
    }
  }
  return best && bestD <= toleranceSec ? best : null;
}
