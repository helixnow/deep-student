/**
 * 音视频学习页跨插件互操作桥（Interop Protocol v1）。
 *
 * - 字幕段 → `MediaSemanticAnchor`（毫秒时间戳）→ 拖拽 / 「划选即入图」摘录载荷
 * - 反向链接：`vfs_anchor_edges` 的 targetStartMs 映射到所在字幕段（容差 ±2000ms 取最近段）
 * - 交互卫生与定位竞态复用 PDF 桥的同一套工具（拖拽闸门、400ms 去重、revealSeq）
 */
import { useEffect, useRef, useState } from 'react';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  parseSemanticAnchor,
  type AnchorEdgeRecord,
  type ExcerptDragInput,
  type MediaSemanticAnchor,
} from '@/ui-kernel/contracts/interop';
export interface AnchorBacklinkSummary {
  total: number;
  mindmapCount: number;
  flashcardCount: number;
  noteCount: number;
  edges: AnchorEdgeRecord[];
}

export type BacklinkCountKind = 'mindmap' | 'flashcard' | 'note';

function emptyBacklinkSummary(): AnchorBacklinkSummary {
  return { total: 0, mindmapCount: 0, flashcardCount: 0, noteCount: 0, edges: [] };
}

function addEdgeToBacklinkSummary(summary: AnchorBacklinkSummary, edge: AnchorEdgeRecord): void {
  summary.total += 1;
  if (edge.sourceKind === 'mindmap') summary.mindmapCount += 1;
  else if (edge.sourceKind === 'flashcard') summary.flashcardCount += 1;
  else if (edge.sourceKind === 'note') summary.noteCount += 1;
  summary.edges.push(edge);
}

/** 胶囊分项（省略 0 计数），顺序固定：导图 · 闪卡 · 笔记 */
export function backlinkCountParts(
  summary: AnchorBacklinkSummary,
): Array<{ kind: BacklinkCountKind; count: number }> {
  const parts: Array<{ kind: BacklinkCountKind; count: number }> = [];
  if (summary.mindmapCount > 0) parts.push({ kind: 'mindmap', count: summary.mindmapCount });
  if (summary.flashcardCount > 0) parts.push({ kind: 'flashcard', count: summary.flashcardCount });
  if (summary.noteCount > 0) parts.push({ kind: 'note', count: summary.noteCount });
  return parts;
}

export const AUTO_EXCERPT_DEDUPE_WINDOW_MS = 400;

function normalizeExcerptQuote(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, '').slice(0, 240);
}

/**
 * 自动摘录闸门：显式拖拽中不发；400ms 内同一 key 只发一次（双击 / mouseup 抖动不产生重复节点）。
 * 拖拽状态在 dragend / drop / blur / visibilitychange / Escape 任一路径复位。
 */
export interface ExcerptInteractionGuard {
  beginDrag(): () => void;
  endDrag(): void;
  isDragging(): boolean;
  shouldEmitAuto(key: string): boolean;
  reset(): void;
}

export function createExcerptInteractionGuard(options: {
  dedupeWindowMs?: number;
  now?: () => number;
  target?: Window;
} = {}): ExcerptInteractionGuard {
  const windowMs = options.dedupeWindowMs ?? AUTO_EXCERPT_DEDUPE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined);
  let dragging = false;
  let dragSession = 0;
  const emittedAt = new Map<string, number>();
  let detach: (() => void) | null = null;

  const endDrag = () => {
    dragSession += 1;
    dragging = false;
    if (detach) {
      const fn = detach;
      detach = null;
      fn();
    }
  };

  const attach = () => {
    if (!target || detach) return;
    const onEnd = () => endDrag();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') endDrag();
    };
    const onVisibility = () => {
      if (target.document?.visibilityState === 'hidden') endDrag();
    };
    target.addEventListener('dragend', onEnd, true);
    target.addEventListener('drop', onEnd, true);
    target.addEventListener('blur', onEnd);
    target.addEventListener('keydown', onKey, true);
    target.document?.addEventListener('visibilitychange', onVisibility);
    detach = () => {
      target.removeEventListener('dragend', onEnd, true);
      target.removeEventListener('drop', onEnd, true);
      target.removeEventListener('blur', onEnd);
      target.removeEventListener('keydown', onKey, true);
      target.document?.removeEventListener('visibilitychange', onVisibility);
    };
  };

  return {
    beginDrag() {
      const session = ++dragSession;
      dragging = true;
      attach();
      return () => { if (session === dragSession) endDrag(); };
    },
    endDrag,
    isDragging: () => dragging,
    shouldEmitAuto(key: string) {
      if (dragging) return false;
      const at = now();
      for (const [previousKey, time] of emittedAt) {
        if (at - time >= windowMs) emittedAt.delete(previousKey);
      }
      if (emittedAt.has(key)) return false;
      emittedAt.set(key, at);
      return true;
    },
    reset() {
      endDrag();
      emittedAt.clear();
    },
  };
}

/** 单调递增的定位令牌：连续点击 A → B 时 A 的高亮等待作废，不会来回跳 */
export interface RevealSequencer {
  next(): number;
  isCurrent(token: number): boolean;
  cancel(): void;
}

export function createRevealSequencer(): RevealSequencer {
  let seq = 0;
  return {
    next: () => {
      seq += 1;
      return seq;
    },
    isCurrent: (token) => token === seq,
    cancel: () => {
      seq += 1;
    },
  };
}

/** 字幕段最小形状（与 TranscriptSegment 兼容；index 取 idx） */
export interface TranscriptCue {
  idx: number;
  startMs: number;
  endMs: number;
}

const MAX_MEDIA_MS = 86_400_000 * 7;
export const CUE_NEAREST_TOLERANCE_MS = 2000;
export const CUE_PULSE_DURATION_MS = 1600;

function truncateCodePoints(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- intentionally strip ASCII control characters from excerpt metadata
  const trimmed = value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  if (!trimmed) return undefined;
  const cps = Array.from(trimmed);
  return cps.length > max ? cps.slice(0, max).join('') : trimmed;
}

function clampMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_MEDIA_MS, Math.max(0, Math.round(value)));
}

export function buildMediaSemanticAnchor(params: {
  resourceId: string;
  aliasResourceId?: string;
  startMs: number;
  endMs?: number;
  quote?: string;
  mediaTitle?: string;
}): MediaSemanticAnchor {
  const resourceId = params.resourceId.trim();
  const startMs = clampMs(params.startMs);
  const endMs = typeof params.endMs === 'number' && Number.isFinite(params.endMs)
    ? Math.max(startMs, clampMs(params.endMs))
    : undefined;
  const alias = params.aliasResourceId?.trim();
  const quote = truncateCodePoints(params.quote, 240);
  const label = truncateCodePoints(params.mediaTitle, 120);
  return {
    kind: 'media',
    resourceId,
    ...(alias && alias !== resourceId ? { aliasResourceId: alias } : {}),
    ...(label ? { label } : {}),
    startMs,
    ...(endMs !== undefined ? { endMs } : {}),
    ...(quote ? { quote } : {}),
  };
}

export function buildMediaExcerptPayload(params: {
  text: string;
  anchor: MediaSemanticAnchor;
  mediaTitle?: string;
  imageDataUrl?: string;
}): ExcerptDragInput {
  const sourceTitle = truncateCodePoints(params.mediaTitle, 120);
  return {
    excerptKind: params.imageDataUrl ? 'region-image' : 'transcript-cue',
    text: params.text,
    ...(params.imageDataUrl ? { imageDataUrl: params.imageDataUrl } : {}),
    anchor: params.anchor,
    ...(sourceTitle ? { sourceTitle } : {}),
  };
}

export function mediaAutoExcerptKey(resourceId: string, startMs: number, quote: string | undefined): string {
  return `${resourceId}|${Math.round(startMs)}|${normalizeExcerptQuote(quote)}`;
}

function resolveEdgeStartMs(edge: AnchorEdgeRecord): number | null {
  if (typeof edge.targetStartMs === 'number' && Number.isFinite(edge.targetStartMs)) return edge.targetStartMs;
  const parsed = parseSemanticAnchor(edge.targetAnchorUri);
  return parsed && parsed.kind === 'media' ? parsed.startMs : null;
}

/**
 * 找时间点所在字幕段：先找 `startMs <= t < endMs` 的段；没有则在 ±tolerance 内取距离最近的段。
 * 返回段的 idx；都不满足返回 null。
 */
export function findCueIndexForMs(
  cues: readonly TranscriptCue[],
  ms: number,
  toleranceMs = CUE_NEAREST_TOLERANCE_MS,
): number | null {
  let nearest: { idx: number; distance: number } | null = null;
  for (const cue of cues) {
    if (cue.startMs <= ms && ms < cue.endMs) return cue.idx;
    const distance = ms < cue.startMs ? cue.startMs - ms : ms - cue.endMs;
    if (distance <= toleranceMs && (!nearest || distance < nearest.distance)) {
      nearest = { idx: cue.idx, distance };
    }
  }
  return nearest ? nearest.idx : null;
}

/** 入边按所在字幕段聚合（key = 段 idx）。同一 edgeId 只计一次。 */
export function groupMediaAnchorEdgesByCue(
  cues: readonly TranscriptCue[],
  edges: readonly AnchorEdgeRecord[],
): Map<number, AnchorBacklinkSummary> {
  const byCue = new Map<number, AnchorBacklinkSummary>();
  if (cues.length === 0) return byCue;
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!edge || edge.targetKind !== 'media' || seen.has(edge.edgeId)) continue;
    const ms = resolveEdgeStartMs(edge);
    if (ms === null) continue;
    const idx = findCueIndexForMs(cues, ms);
    if (idx === null) continue;
    seen.add(edge.edgeId);
    let summary = byCue.get(idx);
    if (!summary) {
      summary = emptyBacklinkSummary();
      byCue.set(idx, summary);
    }
    addEdgeToBacklinkSummary(summary, edge);
  }
  return byCue;
}

/** 字幕区共享的拖拽 / 自动摘录闸门（拖拽把手、点选与划选共用同一份状态） */
export const sharedMediaExcerptGuard = createExcerptInteractionGuard();

/**
 * 紧凑拖拽影像：离屏小胶囊替代整行半透明快照；下一宏任务移除离屏节点。
 */
export function setCompactCueDragImage(dataTransfer: DataTransfer | null | undefined, label: string): void {
  if (!dataTransfer || typeof dataTransfer.setDragImage !== 'function' || typeof document === 'undefined') return;
  const ghost = document.createElement('div');
  ghost.textContent = label;
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    maxWidth: '220px',
    padding: '3px 10px',
    borderRadius: '999px',
    border: '1px solid hsl(var(--border) / 0.35)',
    background: 'hsl(var(--card))',
    color: 'hsl(var(--foreground))',
    font: '500 11px/1.4 var(--font-sans, system-ui, sans-serif)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(ghost);
  try {
    dataTransfer.setDragImage(ghost, 12, 12);
  } catch {
    // 个别 WebView 不支持自定义拖拽影像：退回默认快照
  }
  window.setTimeout(() => ghost.remove(), 0);
}

export function buildCueDragLabel(clock: string, text: string): string {
  const snippet = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 18).join('');
  return snippet ? `${clock} · ${snippet}` : clock;
}

/** 媒体元数据就绪前保留最后一次定位；每个实例单独注册，不抢占其他标签。 */
export function useMediaAnchorReveal(options: {
  resourceId: string;
  resourceIds: readonly string[];
  rootRef: React.RefObject<HTMLElement | null>;
  canSeek: boolean;
  isActive: boolean;
  onRequest: () => void;
  onSeek: (seconds: number) => boolean;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [pulsedCue, setPulsedCue] = useState<{ startMs: number; nonce: number } | null>(null);
  const pending = useRef<{ anchor: MediaSemanticAnchor; pulse: boolean; nonce: number } | null>(null);
  const seq = useRef(0);
  const applyRef = useRef<() => void>(() => {});
  const idsKey = JSON.stringify(options.resourceIds);
  useEffect(() => {
    const resourceId = options.resourceId;
    let disposed = false;
    const matches = (anchor: MediaSemanticAnchor) => {
      const current = latest.current;
      return !disposed && current.resourceId === resourceId && current.isActive
        && (current.resourceIds.includes(anchor.resourceId)
          || Boolean(anchor.aliasResourceId && current.resourceIds.includes(anchor.aliasResourceId)));
    };
    const apply = () => {
      const request = pending.current;
      if (!request || !matches(request.anchor) || !latest.current.canSeek) return;
      pending.current = null;
      if (!latest.current.onSeek(request.anchor.startMs / 1000)) {
        pending.current = request;
        return;
      }
      if (request.pulse) setPulsedCue({ startMs: request.anchor.startMs, nonce: request.nonce });
    };
    applyRef.current = apply;
    const unregister = getAppKernel().anchors.registerAnchorRevealHandler('media', {
      canHandle: (anchor) => {
        if (!matches(anchor)) return false;
        return latest.current.rootRef.current?.contains(document.activeElement) ? 'exact-focused' : 'exact-mounted';
      },
      reveal: (anchor, ctx) => {
        if (ctx.signal?.aborted || !matches(anchor)) return false;
        const nonce = ++seq.current;
        latest.current.onRequest();
        setPulsedCue(null);
        pending.current = { anchor, pulse: ctx.pulse, nonce };
        apply();
        return true;
      },
    });
    return () => { disposed = true; unregister(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.resourceId, idsKey]);
  useEffect(() => {
    pending.current = null;
    setPulsedCue(null);
  }, [options.resourceId]);
  useEffect(() => applyRef.current(), [options.canSeek, options.isActive, idsKey]);
  return pulsedCue;
}
