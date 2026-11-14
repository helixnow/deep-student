/**
 * PDF 阅读器跨插件互操作桥（Interop Protocol v1）。
 *
 * - 选区 / 框选 → 归一化页面坐标（coordVersion 2，[0, 1]，左上角原点）→ `PdfSemanticAnchor`
 * - 摘录载荷：拖拽（`dnd.startExcerptDrag`）与「划选即入图」（`dnd.emitAutoExcerpt`）共用
 * - 反向链接：`vfs_anchor_edges` 按页聚合，供页边 Mineral 胶囊渲染
 * - 交互卫生：显式拖拽期间抑制自动摘录、400ms 内同一 (资源, 页, 摘录) 去重、
 *   所有退出路径（dragend / drop / blur / visibilitychange / Escape）复位拖拽状态
 * - 定位竞态：单调递增的 revealSeq 令牌，连续点击 A → B 时 A 的等待自动作废，不会来回跳页
 */
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  DS_EXCERPT_MIME,
  parseSemanticAnchor,
  type AnchorEdgeRecord,
  type ExcerptDragInput,
  type ExcerptDragPayload,
  type NormalizedRect,
  type PdfSemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import { startExcerptDrag as fallbackStartExcerptDrag } from '@/ui-kernel/services/excerpt-dnd';

type RectLike = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

const QUOTE_MAX_CODE_POINTS = 240;
const LABEL_MAX_CODE_POINTS = 120;

export const AUTO_EXCERPT_DEDUPE_WINDOW_MS = 400;
export const ANCHOR_PULSE_DURATION_MS = 1800;
export const REVEAL_PAGE_MOUNT_TIMEOUT_MS = 2500;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function truncateCodePoints(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- intentionally strip ASCII control characters from excerpt metadata
  const trimmed = value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  if (!trimmed) return undefined;
  const cps = Array.from(trimmed);
  return cps.length > max ? cps.slice(0, max).join('') : trimmed;
}

/**
 * 选区各行矩形的并集，换算为相对页面包裹层的归一化坐标。
 * 页面尺寸无效或并集为空时返回 undefined；浮点漂移夹到 [0, 1]。
 */
export function computeNormalizedSelectionBounds(
  rangeRects: ArrayLike<RectLike>,
  pageRect: RectLike,
): NormalizedRect | undefined {
  if (![pageRect.left, pageRect.top, pageRect.width, pageRect.height].every(Number.isFinite)
    || !(pageRect.width > 0) || !(pageRect.height > 0)) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < rangeRects.length; i += 1) {
    const r = rangeRects[i];
    if (!r || !(r.width > 0) || !(r.height > 0)) continue;
    if (![r.left, r.top, r.width, r.height].every(Number.isFinite)) continue;
    const left = Math.max(r.left, pageRect.left);
    const top = Math.max(r.top, pageRect.top);
    const right = Math.min(r.left + r.width, pageRect.left + pageRect.width);
    const bottom = Math.min(r.top + r.height, pageRect.top + pageRect.height);
    if (right <= left || bottom <= top) continue;
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, bottom);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  const x0 = clamp01((minX - pageRect.left) / pageRect.width);
  const y0 = clamp01((minY - pageRect.top) / pageRect.height);
  const x1 = clamp01((maxX - pageRect.left) / pageRect.width);
  const y1 = clamp01((maxY - pageRect.top) / pageRect.height);
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 0) || !(h > 0)) return undefined;
  return { x: x0, y: y0, w, h };
}

/** 锚点统一保存未旋转页面坐标；显示时按当前 PDF.js 旋转角度转换。 */
export function rotateNormalizedRect(rect: NormalizedRect, rotation: number): NormalizedRect | undefined {
  const clipped = computeNormalizedSelectionBounds(
    [{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }],
    { left: 0, top: 0, width: 1, height: 1 },
  );
  if (!clipped) return undefined;
  const { x, y, w, h } = clipped;
  switch (((rotation % 360) + 360) % 360) {
    case 90: return { x: Math.max(0, 1 - y - h), y: x, w: h, h: w };
    case 180: return { x: Math.max(0, 1 - x - w), y: Math.max(0, 1 - y - h), w, h };
    case 270: return { x: y, y: Math.max(0, 1 - x - w), w: h, h: w };
    default: return clipped;
  }
}

export function buildPdfSemanticAnchor(params: {
  resourceId: string;
  aliasResourceId?: string;
  page: number;
  rect?: NormalizedRect;
  quote?: string;
  documentTitle?: string;
}): PdfSemanticAnchor {
  const page = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page)) : 1;
  const alias = params.aliasResourceId?.trim();
  const quote = truncateCodePoints(params.quote, QUOTE_MAX_CODE_POINTS);
  const label = truncateCodePoints(params.documentTitle, LABEL_MAX_CODE_POINTS);
  return {
    kind: 'pdf',
    resourceId: params.resourceId.trim(),
    ...(alias && alias !== params.resourceId.trim() ? { aliasResourceId: alias } : {}),
    ...(label ? { label } : {}),
    page,
    ...(params.rect ? { rect: params.rect } : {}),
    ...(quote ? { quote } : {}),
  };
}

export type PdfExcerptDragInput = ExcerptDragInput & {
  /** 双轨框选提取到的标准 LaTeX 公式块 */
  latex?: string;
};

export function composeDualTrackExcerptText(text: string | undefined, latex?: string): string {
  const cleanText = typeof text === 'string' ? text.trim() : '';
  const cleanLatex = typeof latex === 'string' ? latex.trim() : '';
  if (!cleanLatex) return cleanText;
  if (!cleanText) return cleanLatex;
  if (
    cleanText.includes(cleanLatex) ||
    cleanText.replace(/\s+/g, '').includes(cleanLatex.replace(/\s+/g, ''))
  ) {
    return cleanText;
  }
  return `${cleanText}\n\n${cleanLatex}`;
}

export function buildPdfExcerptPayload(params: {
  excerptKind: 'text' | 'region-image';
  text: string;
  latex?: string;
  imageDataUrl?: string;
  anchor: PdfSemanticAnchor;
  documentTitle?: string;
}): PdfExcerptDragInput {
  const sourceTitle = truncateCodePoints(params.documentTitle, LABEL_MAX_CODE_POINTS);
  const cleanLatex = typeof params.latex === 'string' && params.latex.trim() ? params.latex.trim() : undefined;
  const composedText = cleanLatex ? composeDualTrackExcerptText(params.text, cleanLatex) : params.text;
  return {
    excerptKind: params.excerptKind,
    text: composedText,
    ...(cleanLatex ? { latex: cleanLatex } : {}),
    ...(params.imageDataUrl ? { imageDataUrl: params.imageDataUrl } : {}),
    anchor: params.anchor,
    ...(sourceTitle ? { sourceTitle } : {}),
  };
}

/**
 * 启动双轨框选或文本摘录拖拽：写入标准 `DS_EXCERPT_MIME` 的同时保留 `imageDataUrl`、`text` 与 `latex` 复合字段。
 */
export function startDualTrackPdfExcerptDrag(
  event: Pick<DragEvent, 'dataTransfer'>,
  input: PdfExcerptDragInput,
): (ExcerptDragPayload & { latex?: string }) | null {
  const dnd = getAppKernel()?.dnd;
  const payload = dnd?.startExcerptDrag
    ? dnd.startExcerptDrag(event, input)
    : fallbackStartExcerptDrag(event, input);
  if (!payload) return null;

  const cleanLatex = input.latex?.trim();
  if (!cleanLatex) return payload;

  const enriched: ExcerptDragPayload & { latex: string } = {
    ...payload,
    latex: cleanLatex,
  };
  const dt = event?.dataTransfer;
  if (dt && typeof dt.setData === 'function') {
    try {
      dt.setData(DS_EXCERPT_MIME, JSON.stringify(enriched));
    } catch {
      // 合成事件只读时保持已写入的标准载荷
    }
  }
  return enriched;
}

// ============================================================================
// 反向链接聚合
// ============================================================================

export interface AnchorBacklinkSummary {
  total: number;
  mindmapCount: number;
  flashcardCount: number;
  noteCount: number;
  edges: AnchorEdgeRecord[];
}

export function emptyBacklinkSummary(): AnchorBacklinkSummary {
  return { total: 0, mindmapCount: 0, flashcardCount: 0, noteCount: 0, edges: [] };
}

export function addEdgeToBacklinkSummary(summary: AnchorBacklinkSummary, edge: AnchorEdgeRecord): void {
  summary.total += 1;
  if (edge.sourceKind === 'mindmap') summary.mindmapCount += 1;
  else if (edge.sourceKind === 'flashcard') summary.flashcardCount += 1;
  else if (edge.sourceKind === 'note') summary.noteCount += 1;
  summary.edges.push(edge);
}

function resolveEdgePage(edge: AnchorEdgeRecord): number | null {
  if (typeof edge.targetPage === 'number' && Number.isInteger(edge.targetPage) && edge.targetPage >= 1) {
    return edge.targetPage;
  }
  const parsed = parseSemanticAnchor(edge.targetAnchorUri);
  return parsed && parsed.kind === 'pdf' ? parsed.page : null;
}

/** 按 1-based 目标页聚合入边；targetPage 缺失时回退解析 targetAnchorUri。同一 edgeId 只计一次。 */
export function groupPdfAnchorEdgesByPage(
  edges: readonly AnchorEdgeRecord[],
): Map<number, AnchorBacklinkSummary> {
  const byPage = new Map<number, AnchorBacklinkSummary>();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!edge || edge.targetKind !== 'pdf' || seen.has(edge.edgeId)) continue;
    const page = resolveEdgePage(edge);
    if (page === null) continue;
    seen.add(edge.edgeId);
    let summary = byPage.get(page);
    if (!summary) {
      summary = emptyBacklinkSummary();
      byPage.set(page, summary);
    }
    addEdgeToBacklinkSummary(summary, edge);
  }
  return byPage;
}

export type BacklinkCountKind = 'mindmap' | 'flashcard' | 'note';

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

// ============================================================================
// 交互卫生：拖拽状态 + 自动摘录去重
// ============================================================================

export interface ExcerptInteractionGuard {
  /** 显式拖拽开始：安装所有退出路径的复位监听 */
  beginDrag(): () => void;
  /** 显式拖拽结束（幂等） */
  endDrag(): void;
  isDragging(): boolean;
  /** 自动摘录闸门：拖拽中或 400ms 内同一 key 已发出时返回 false */
  shouldEmitAuto(key: string): boolean;
  /** 卸载监听并复位 */
  reset(): void;
}

export function normalizeExcerptQuote(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, '').slice(0, QUOTE_MAX_CODE_POINTS);
}

export function pdfAutoExcerptKey(resourceId: string, page: number, quote: string | undefined, rect?: NormalizedRect): string {
  const rectKey = rect ? `${rect.x.toFixed(3)},${rect.y.toFixed(3)},${rect.w.toFixed(3)},${rect.h.toFixed(3)}` : '';
  return `${resourceId}|${page}|${normalizeExcerptQuote(quote)}|${rectKey}`;
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

/** 阅读器内共享的拖拽 / 自动摘录闸门（划词胶囊、框选摘录与自动摘录监听共用同一份状态） */
export const sharedPdfExcerptGuard = createExcerptInteractionGuard();

/**
 * 紧凑拖拽影像：用离屏小胶囊替代 Chromium 默认的整块半透明快照。
 * 下一宏任务移除离屏节点（浏览器在 dragstart 同步阶段已完成位图采样）。
 */
export function setCompactDragImage(dataTransfer: DataTransfer | null | undefined, label: string): void {
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

export function buildExcerptDragLabel(locator: string, text: string): string {
  const snippet = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 18).join('');
  return snippet ? `${locator} · ${snippet}` : locator;
}

// ============================================================================
// 定位竞态：revealSeq
// ============================================================================

export interface RevealSequencer {
  /** 开始一次新的定位，旧令牌全部作废 */
  next(): number;
  isCurrent(token: number): boolean;
  /** 作废所有进行中的定位（换文档 / 卸载） */
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

export function clampRevealPage(page: number, numPages: number): number {
  const target = Number.isFinite(page) ? Math.floor(page) : 1;
  const upper = numPages > 0 ? numPages : Math.max(1, target);
  return Math.max(1, Math.min(upper, target));
}

/**
 * 虚拟化页面在第 0 帧可能尚未挂载：先由调用方滚动，再在此等待目标页包裹层出现且有高度。
 * 令牌过期（被更新的定位取代）或超时返回 null。
 */
export async function waitForPdfPageElement(
  root: ParentNode | null | undefined,
  page: number,
  options: { isCurrent: () => boolean; signal?: AbortSignal; timeoutMs?: number; intervalMs?: number; now?: () => number },
): Promise<HTMLElement | null> {
  const timeoutMs = options.timeoutMs ?? REVEAL_PAGE_MOUNT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 40;
  const now = options.now ?? (() => Date.now());
  const started = now();
  for (;;) {
    if (options.signal?.aborted || !options.isCurrent()) return null;
    const el = root?.querySelector<HTMLElement>(`[data-page-number="${page}"]`) ?? null;
    if (el && el.getBoundingClientRect().height > 0) return el;
    if (now() - started >= timeoutMs) return null;
    await waitForPdfTask(intervalMs, options.signal);
  }
}

/** 可立即取消的等待：换文档或卸载时不遗留轮询定时器。 */
export function waitForPdfTask(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// ============================================================================
// 框选图片：PNG Blob → dataURL（长边限制）
// ============================================================================

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

export async function decodeCapturedRegion(
  blob: Blob,
  maxEdge = 1200,
): Promise<{ dataUrl: string; width: number; height: number }> {
  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      if (scale === 1) {
        bitmap.close?.();
        return { dataUrl: await readBlobAsDataUrl(blob), width, height };
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        return { dataUrl: canvas.toDataURL('image/png'), width, height };
      }
      bitmap.close?.();
    } catch {
      // 解码失败：退回原图 dataURL
    }
  }
  return { dataUrl: await readBlobAsDataUrl(blob), width: 0, height: 0 };
}
