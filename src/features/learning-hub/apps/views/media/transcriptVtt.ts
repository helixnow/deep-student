/**
 * 字幕段 → WebVTT（blob URL 字幕轨）+ 增量更新
 *
 * 契约 §2：「WebVTT 字幕轨（由段生成 blob URL；增量更新不重建轨道）」。
 * - 首次有完成段时生成一份 VTT 文本挂到 `<track src=blob:…>`；每个 cue 带
 *   标识 `seg-<idx>`，加载后可经 `TextTrack.cues.getCueById` 定位。
 * - 之后的段更新（转写进行中逐段完成、导入替换）只做 addCue/removeCue 差量，
 *   不替换 `<track>` 的 src —— 重建轨道会让正在显示的字幕闪断并重新解析整份文件。
 */

import type { TranscriptSegment } from './mediaTranscriptApi';

/** 毫秒 → `hh:mm:ss.mmm`（WebVTT 时间戳，小时位总是输出，兼容 ≥ 100h 以外的全部场景） */
export function formatVttTimestamp(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

export function cueIdForSegment(idx: number): string {
  return `seg-${idx}`;
}

/** 只有已完成且有文本的段进入字幕轨 */
export function isRenderableSegment(seg: TranscriptSegment): boolean {
  return seg.status === 'done' && seg.text.trim().length > 0 && seg.endMs > seg.startMs;
}

/** cue 正文里禁止出现空行与 `-->`（会被解析器当作 cue 边界） */
export function sanitizeCueText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/-->/g, '→');
}

export function buildWebVtt(segments: readonly TranscriptSegment[]): string {
  const lines = ['WEBVTT', ''];
  for (const seg of segments) {
    if (!isRenderableSegment(seg)) continue;
    lines.push(cueIdForSegment(seg.idx));
    lines.push(`${formatVttTimestamp(seg.startMs)} --> ${formatVttTimestamp(seg.endMs)}`);
    lines.push(sanitizeCueText(seg.text));
    lines.push('');
  }
  return lines.join('\n');
}

/** 段的可见内容指纹：时间或文本变了才需要替换 cue */
export function segmentCueSignature(seg: TranscriptSegment): string {
  return `${seg.startMs}|${seg.endMs}|${sanitizeCueText(seg.text)}`;
}

export interface CueSyncPlan {
  add: TranscriptSegment[];
  /** 需移除的段 idx（含内容变化后先删后加的段） */
  remove: number[];
}

/** 纯函数：对比「已应用」与最新段，算出增删 */
export function planCueSync(
  applied: ReadonlyMap<number, string>,
  segments: readonly TranscriptSegment[],
): CueSyncPlan {
  const next = new Map<number, TranscriptSegment>();
  for (const seg of segments) {
    if (isRenderableSegment(seg)) next.set(seg.idx, seg);
  }
  const add: TranscriptSegment[] = [];
  const remove: number[] = [];
  for (const [idx, signature] of applied) {
    const seg = next.get(idx);
    if (!seg || segmentCueSignature(seg) !== signature) remove.push(idx);
  }
  for (const [idx, seg] of next) {
    if (applied.get(idx) !== segmentCueSignature(seg)) add.push(seg);
  }
  add.sort((a, b) => a.startMs - b.startMs);
  return { add, remove };
}

/** TextTrack 的最小可测接口 */
export interface CueTrackLike {
  readonly cues: { getCueById(id: string): unknown } | null;
  addCue(cue: never): void;
  removeCue(cue: never): void;
}

export type CueFactory = (startSec: number, endSec: number, text: string) => { id: string };

const defaultCueFactory: CueFactory = (start, end, text) => {
  const Ctor = (globalThis as { VTTCue?: new (s: number, e: number, t: string) => { id: string } })
    .VTTCue;
  if (!Ctor) throw new Error('VTTCue unavailable');
  return new Ctor(start, end, text);
};

/**
 * 增量同步器：seed 为生成 blob VTT 时用的段（其 cue 已由 `<track>` 加载），
 * 之后每次 sync 只对差量调用 addCue/removeCue。
 */
export function createCueSynchronizer(
  seedSegments: readonly TranscriptSegment[],
  createCue: CueFactory = defaultCueFactory,
) {
  const applied = new Map<number, string>();
  for (const seg of seedSegments) {
    if (isRenderableSegment(seg)) applied.set(seg.idx, segmentCueSignature(seg));
  }
  return {
    /** @returns 实际变更的 cue 数 */
    sync(track: CueTrackLike, segments: readonly TranscriptSegment[]): number {
      const plan = planCueSync(applied, segments);
      let changed = 0;
      for (const idx of plan.remove) {
        const cue = track.cues?.getCueById(cueIdForSegment(idx));
        if (cue) {
          try {
            track.removeCue(cue as never);
            changed += 1;
          } catch {
            /* cue 已不在轨上 */
          }
        }
        applied.delete(idx);
      }
      for (const seg of plan.add) {
        try {
          const cue = createCue(seg.startMs / 1000, seg.endMs / 1000, sanitizeCueText(seg.text));
          cue.id = cueIdForSegment(seg.idx);
          track.addCue(cue as never);
          applied.set(seg.idx, segmentCueSignature(seg));
          changed += 1;
        } catch {
          // VTTCue 不可用（极旧 WebView）：字幕面板仍可用，仅轨道不增量
        }
      }
      return changed;
    },
    appliedCount(): number {
      return applied.size;
    },
  };
}

/** 二分：当前播放时间所在段（无段覆盖时返回最近一个已开始的段；都未开始返回 -1） */
export function findActiveSegmentIndex(
  segments: readonly TranscriptSegment[],
  timeMs: number,
): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startMs <= timeMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
