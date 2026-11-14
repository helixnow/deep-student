/**
 * PDF 学术阅读视口增强纯函数：
 * 1. 智能裁白边（Trim Margins）：在保持 `pdf.js` 原生矢量清晰度、高亮 0–1 相对坐标与
 *    `PdfRegionCapture` 截图像素完全不变的前提下，计算放大后的渲染宽度与四周负边距裁切盒；
 * 2. 双栏论文单栏贴合缩放（Smart Column Double-Click Zoom）：根据双击横向落点智能聚焦左栏/右栏，
 *    再次双击恢复原缩放模式；
 * 3. 进度条批注与搜索热力刻度（Progress-Bar Tick Marks）：将 1-based 页码的五色语义高亮与搜索命中
 *    聚合为进度条微刻度点。
 */

import type { PdfFitMode } from './stores/pdfSettingsStore';

// ============================================================================
// 1. 紧凑裁白边（Trim Margins）
// ============================================================================

/** 左右各裁去 8.5%（合计 17% 水平留白，等效正文字号放大 ~20.5%） */
export const DEFAULT_TRIM_MARGIN_X = 0.085;
/** 上下各裁去 5.5%（合计 11% 页眉页脚留白） */
export const DEFAULT_TRIM_MARGIN_Y = 0.055;

export interface TrimmedPageLayout {
  /** 传给 `<Page width={...} />` 的实际渲染宽度（裁白边时大于可视宽度，保证原生矢量清晰） */
  renderWidth: number;
  /** 外层裁切框的可视宽度 */
  visibleWidth: number;
  /** 外层裁切框的估算可视高度（基于页面宽高比 `height / width`） */
  visibleHeight: number;
  /** 内层 `.ds-pdf__page-wrapper` 的负水平偏移（px，≤ 0） */
  offsetX: number;
  /** 内层 `.ds-pdf__page-wrapper` 的负垂直偏移（px，≤ 0） */
  offsetY: number;
}

export function computeTrimmedPageLayout(
  visiblePageWidth: number,
  pageAspectRatio: number,
  trimMargins: boolean,
  trimX: number = DEFAULT_TRIM_MARGIN_X,
  trimY: number = DEFAULT_TRIM_MARGIN_Y,
): TrimmedPageLayout {
  const safeVisibleW = Math.max(1, visiblePageWidth);
  const safeRatio = pageAspectRatio > 0 ? pageAspectRatio : 1.414;

  if (!trimMargins) {
    return {
      renderWidth: safeVisibleW,
      visibleWidth: safeVisibleW,
      visibleHeight: safeVisibleW * safeRatio,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const clampedX = Math.min(0.2, Math.max(0.02, trimX));
  const clampedY = Math.min(0.18, Math.max(0.02, trimY));
  const renderWidth = Math.round(safeVisibleW / (1 - 2 * clampedX));
  const fullRenderHeight = renderWidth * safeRatio;
  const offsetX = -Math.round(renderWidth * clampedX);
  const offsetY = -Math.round(fullRenderHeight * clampedY);
  const visibleHeight = Math.max(1, Math.round(fullRenderHeight * (1 - 2 * clampedY)));

  return {
    renderWidth,
    visibleWidth: safeVisibleW,
    visibleHeight,
    offsetX,
    offsetY,
  };
}

// ============================================================================
// 2. 双栏论文单栏贴合双击缩放（Smart Column Zoom）
// ============================================================================

/** 双栏学术论文单栏贴合默认倍率（单栏宽度约占版心 44%–48%，1.85x 恰好舒适铺满视口） */
export const SINGLE_COLUMN_ZOOM_SCALE = 1.85;

export interface SavedColumnZoomBaseline {
  zoomMode: PdfFitMode;
  scale: number;
  scrollLeft: number;
}

export type ColumnZoomDecision =
  | {
      action: 'zoom_in';
      column: 'left' | 'center' | 'right';
      nextScale: number;
      targetScrollLeft: number;
      baselineToSave: SavedColumnZoomBaseline;
    }
  | {
      action: 'restore';
      zoomMode: PdfFitMode;
      nextScale: number;
      targetScrollLeft: number;
    };

export function computeColumnDoubleClickZoom(input: {
  currentZoomMode: PdfFitMode;
  currentScale: number;
  currentScrollLeft: number;
  savedBaseline: SavedColumnZoomBaseline | null;
  clickClientX: number;
  pageRect: { left: number; width: number };
  viewportWidth: number;
  columnScale?: number;
}): ColumnZoomDecision {
  const {
    currentZoomMode,
    currentScale,
    currentScrollLeft,
    savedBaseline,
    clickClientX,
    pageRect,
    viewportWidth,
    columnScale = SINGLE_COLUMN_ZOOM_SCALE,
  } = input;

  // 已处于单栏贴合态（或已有保存基线且当前倍率接近单栏倍率）：再次双击恢复原视图
  const isAtColumnScale =
    currentZoomMode === 'custom' && Math.abs(currentScale - columnScale) <= 0.12;
  if (savedBaseline && isAtColumnScale) {
    return {
      action: 'restore',
      zoomMode: savedBaseline.zoomMode,
      nextScale: savedBaseline.scale,
      targetScrollLeft: savedBaseline.scrollLeft,
    };
  }
  if (!savedBaseline && isAtColumnScale) {
    return {
      action: 'restore',
      zoomMode: 'fitWidth',
      nextScale: 1.0,
      targetScrollLeft: 0,
    };
  }

  const safePageWidth = Math.max(1, pageRect.width);
  const relX = Math.min(1, Math.max(0, (clickClientX - pageRect.left) / safePageWidth));

  // 左栏中心约在页面宽 28%，右栏中心约在 72%，中缝附近（44%–56%）居中放大
  let column: 'left' | 'center' | 'right';
  let anchorRatio: number;
  if (relX < 0.44) {
    column = 'left';
    anchorRatio = 0.28;
  } else if (relX > 0.56) {
    column = 'right';
    anchorRatio = 0.72;
  } else {
    column = 'center';
    anchorRatio = 0.5;
  }

  const safeBaseScale = Math.max(0.25, currentScale);
  const scaledPageWidth = safePageWidth * (columnScale / safeBaseScale);
  const safeViewportW = Math.max(1, viewportWidth);
  // 页面在容器中水平居中排布时，scrollContent 宽度约为 max(viewportWidth, scaledPageWidth + padding)
  const targetScrollLeft = Math.max(
    0,
    Math.round(scaledPageWidth * anchorRatio - safeViewportW / 2),
  );

  return {
    action: 'zoom_in',
    column,
    nextScale: columnScale,
    targetScrollLeft,
    baselineToSave: {
      zoomMode: currentZoomMode,
      scale: currentScale,
      scrollLeft: currentScrollLeft,
    },
  };
}

// ============================================================================
// 3. 进度条批注与搜索热力刻度（Progress-Bar Tick Marks）
// ============================================================================

export interface ProgressBarTickHighlightLike {
  pageIndex: number;
  color: string;
  text: string;
  comment?: string;
}

export interface ProgressBarTickSearchLike {
  pageIndex: number;
}

export interface ProgressBarTick {
  /** 1-based 页码 */
  page: number;
  /** 在进度条上的水平百分比位置（0–100，对齐 `progressPosToPage` 命中区间） */
  percent: number;
  /** 刻度主色（优先使用该页第一条高亮的语义色；仅搜索命中时为 null，走主题检索色） */
  color: string | null;
  /** 该页高亮批注数量 */
  highlightCount: number;
  /** 该页搜索命中数量 */
  searchCount: number;
  /** 该页首条摘录/批注摘要（供 tooltip 预览） */
  previewText: string;
}

export function buildProgressBarTicks(input: {
  numPages: number;
  highlights: readonly ProgressBarTickHighlightLike[];
  searchResults?: readonly ProgressBarTickSearchLike[];
  searchActive?: boolean;
}): ProgressBarTick[] {
  const { numPages, highlights, searchResults = [], searchActive = false } = input;
  if (numPages <= 0) return [];

  const byPage = new Map<
    number,
    {
      color: string | null;
      highlightCount: number;
      searchCount: number;
      previewText: string;
    }
  >();

  for (const hl of highlights) {
    const page = hl.pageIndex;
    if (!Number.isInteger(page) || page < 1 || page > numPages) continue;
    const snippetSource = hl.comment?.trim() ? `${hl.comment.trim()} — ${hl.text}` : hl.text;
    const cleaned = snippetSource.replace(/\s+/g, ' ').trim().slice(0, 72);
    const existing = byPage.get(page);
    if (existing) {
      existing.highlightCount += 1;
      if (!existing.color && hl.color) existing.color = hl.color;
      if (!existing.previewText && cleaned) existing.previewText = cleaned;
    } else {
      byPage.set(page, {
        color: hl.color || null,
        highlightCount: 1,
        searchCount: 0,
        previewText: cleaned,
      });
    }
  }

  if (searchActive && searchResults.length > 0) {
    for (const match of searchResults) {
      const page = match.pageIndex;
      if (!Number.isInteger(page) || page < 1 || page > numPages) continue;
      const existing = byPage.get(page);
      if (existing) {
        existing.searchCount += 1;
      } else {
        byPage.set(page, {
          color: null,
          highlightCount: 0,
          searchCount: 1,
          previewText: '',
        });
      }
    }
  }

  const ticks: ProgressBarTick[] = [];
  for (const [page, entry] of byPage.entries()) {
    const percent = Math.min(99.2, Math.max(0.8, ((page - 0.5) / numPages) * 100));
    ticks.push({
      page,
      percent: Math.round(percent * 100) / 100,
      color: entry.color,
      highlightCount: entry.highlightCount,
      searchCount: entry.searchCount,
      previewText: entry.previewText,
    });
  }

  return ticks.sort((a, b) => a.page - b.page);
}
