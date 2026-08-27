/**
 * PDF 批注列表纯逻辑（0824 Wave2-B r5「SOTA-PDF」：S1/S2/S4/S5 的可测内核）
 *
 * 侧栏批注 tab 的组织与回链能力（对标 Zotero 批注面板 / PDF Expert
 * Annotation Summary）全部落在这里，UI 只做接线：
 * - 排序/分组：页码 → 页内位置 → 创建时间（S1 列表组织）
 * - 筛选：颜色 chips + 文本过滤（S5 子集，纯前端列表过滤）
 * - 汇总导出：highlights[] → Markdown（S2，引用块 + 页标题 + 来源回链行）
 * - 来源行回链：`[…第 N 页](pdfref://<sourceId>?page=N)`（S4 写入侧；
 *   点击侧见 src/components/crepe/plugins/pdfRef）
 *
 * 不依赖 React / DOM / i18n：文案由调用方注入（labels），保证可单测。
 */

import { buildPdfRefHref } from '@/components/crepe/plugins/pdfRef/protocol';
import { formatSelectionQuoteBlock } from './pdfSelectionActions';

/**
 * 批注列表关心的最小高亮形状（EnhancedPdfViewer 的 Highlight 结构性满足）。
 * rects 坐标语义见 EnhancedPdfViewer：coordVersion===2 为 0–1 相对坐标，
 * 历史数据为捕获时像素坐标——两者在同一页内都随位置单调，可用于页内排序。
 */
export interface AnnotationHighlight {
  id: string;
  pageIndex: number;
  text: string;
  color: string;
  rects: { x: number; y: number; width: number; height: number }[];
  createdAt: number;
  coordVersion?: number;
}

// ============================================================================
// 排序 / 分组
// ============================================================================

/** 页内排序键：首个矩形的最小 top（无 rects 时排到页尾） */
function topOf(hl: AnnotationHighlight): number {
  if (!hl.rects.length) return Number.POSITIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (const rect of hl.rects) {
    if (rect.y < min) min = rect.y;
  }
  return min;
}

/**
 * 阅读顺序排序：页码升序 → 页内 top 升序 → createdAt 升序兜底。
 * 同页混用坐标版本（0–1 相对 vs 历史像素）时 top 不同尺度，此时退回
 * createdAt 保证确定性（历史数据边缘场景，不为它引入页高依赖）。
 */
export function sortHighlightsForList<T extends AnnotationHighlight>(
  highlights: readonly T[],
): T[] {
  return [...highlights].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    const sameCoordSpace = (a.coordVersion ?? 0) === (b.coordVersion ?? 0);
    if (sameCoordSpace) {
      // 逐向比较而非相减：无 rects 的 Infinity 才能真正落到页尾
      // （相减得 ±Infinity/NaN 会被丢弃），NaN（损坏数据）两比较均
      // 不成立，自然落到 createdAt 兜底
      const ta = topOf(a);
      const tb = topOf(b);
      if (ta < tb) return -1;
      if (tb < ta) return 1;
    }
    return a.createdAt - b.createdAt;
  });
}

export interface HighlightPageGroup<T extends AnnotationHighlight> {
  page: number;
  items: T[];
}

/** 按页分组（输入应已经 sortHighlightsForList，分组保持输入顺序） */
export function groupHighlightsByPage<T extends AnnotationHighlight>(
  highlights: readonly T[],
): HighlightPageGroup<T>[] {
  const groups: HighlightPageGroup<T>[] = [];
  for (const hl of highlights) {
    const last = groups[groups.length - 1];
    if (last && last.page === hl.pageIndex) {
      last.items.push(hl);
    } else {
      groups.push({ page: hl.pageIndex, items: [hl] });
    }
  }
  return groups;
}

// ============================================================================
// 筛选（S5：颜色 chips + 文本过滤）
// ============================================================================

export interface AnnotationListFilter {
  /** 选中的颜色（空数组 = 不按颜色过滤）；比较大小写不敏感 */
  colors?: readonly string[];
  /** 文本过滤（对 hl.text 做大小写不敏感包含匹配；空白 = 不过滤） */
  query?: string;
}

function normalizeColor(color: string): string {
  return color.trim().toLowerCase();
}

/** 列表中实际出现过的颜色（首见顺序去重）——chips 数据源，兼容 Agent 写入的非预设色 */
export function collectHighlightColors(
  highlights: readonly AnnotationHighlight[],
): string[] {
  const seen = new Set<string>();
  const colors: string[] = [];
  for (const hl of highlights) {
    const key = normalizeColor(hl.color);
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push(hl.color);
  }
  return colors;
}

/** 颜色 + 文本双条件过滤（AND 语义），保持输入顺序 */
export function filterHighlights<T extends AnnotationHighlight>(
  highlights: readonly T[],
  filter: AnnotationListFilter,
): T[] {
  const colorSet = filter.colors?.length
    ? new Set(filter.colors.map(normalizeColor))
    : null;
  const query = filter.query?.trim().toLowerCase() ?? '';
  if (!colorSet && !query) return [...highlights];
  return highlights.filter((hl) => {
    if (colorSet && !colorSet.has(normalizeColor(hl.color))) return false;
    if (query && !hl.text.toLowerCase().includes(query)) return false;
    return true;
  });
}

// ============================================================================
// 来源行回链（S4 写入侧）
// ============================================================================

/**
 * 从 DSTU resourcePath（如 `/我的教材/tb_xyz789`）取末段资源 id。
 * 末段即 pdf-ref:open 的 sourceId（usePdfFocusListener 按 sourceId/path 匹配）。
 */
export function resourceIdFromDstuPath(
  resourcePath: string | null | undefined,
): string | null {
  if (!resourcePath) return null;
  const segments = resourcePath.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

/**
 * 来源行：有 sourceId → markdown 回链 `[label](pdfref://id?page=N)`；
 * 无 sourceId（独立阅读页打开的裸磁盘文件）→ 纯文本 label 降级。
 */
export function buildAnnotationSourceLine(input: {
  label: string;
  sourceId?: string | null;
  page: number;
}): string {
  if (!input.sourceId) return input.label;
  return `[${input.label}](${buildPdfRefHref(input.sourceId, input.page)})`;
}

// ============================================================================
// 批注汇总导出（S2）
// ============================================================================

export interface AnnotationSummaryLabels {
  /** 页分组标题（如「第 3 页」） */
  pageHeading: (page: number) => string;
  /** 来源回链行文案（如「—— 摘自《x.pdf》第 3 页」） */
  sourceLine: (page: number) => string;
}

export interface AnnotationSummaryInput {
  highlights: readonly AnnotationHighlight[];
  /** DSTU 资源 id（无则来源行降级为纯文本，不出回链） */
  sourceId?: string | null;
  labels: AnnotationSummaryLabels;
}

/**
 * 批注汇总 Markdown（对标 PDF Expert Annotation Summary / Zotero
 * Add Note from Annotations）：按页分组，每条 = 引用块 + 来源回链行。
 * 空列表返回空串（调用方应在 UI 层禁用导出按钮，而不是导出空笔记）。
 */
export function buildAnnotationSummaryMarkdown(
  input: AnnotationSummaryInput,
): string {
  const sorted = sortHighlightsForList(input.highlights);
  if (!sorted.length) return '';
  const groups = groupHighlightsByPage(sorted);
  const sections: string[] = [];
  for (const group of groups) {
    const lines: string[] = [`## ${input.labels.pageHeading(group.page)}`];
    for (const hl of group.items) {
      lines.push(
        '',
        formatSelectionQuoteBlock(hl.text),
        '',
        buildAnnotationSourceLine({
          label: input.labels.sourceLine(group.page),
          sourceId: input.sourceId,
          page: group.page,
        }),
      );
    }
    sections.push(lines.join('\n'));
  }
  return `${sections.join('\n\n')}\n`;
}
