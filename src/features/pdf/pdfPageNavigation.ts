/**
 * PDF 翻页导航纯函数
 *
 * 双页（spread）模式下页面按 [1,2] [3,4] … 成对排布（奇数页为行首）。
 * 单页步进 ±1 在双页模式下会落进同一 spread，视觉上毫无变化——
 * 翻页必须以 spread 为单位步进 ±2，并对齐到 spread 首页。
 *
 * 封面偏移（coverOffset）：书籍类 PDF 第 1 页是封面时，真实对页是
 * [2,3] [4,5] …。开启后第 1 页单独成行，其余 spread 以偶数页为行首。
 *
 * 仅覆盖「翻页」语义（←/→、PageUp/PageDown、工具栏按钮）；
 * 空格滚屏走视口 scrollBy，与此处无关。
 */

export type PdfViewMode = 'single' | 'dual';

/**
 * 页码所在 spread 的首页。
 * - 标准配对 [1,2] [3,4] …：奇数页为行首；
 * - 封面偏移 [1] [2,3] [4,5] …：第 1 页独占，其余偶数页为行首。
 */
export function getSpreadStart(page: number, coverOffset = false): number {
  if (coverOffset) {
    if (page <= 1) return 1;
    return page - (page % 2 === 1 ? 1 : 0);
  }
  return page - ((page - 1) % 2);
}

/** 最后一个 spread 的首页（= 可跳转的最大目标页）。 */
function getLastSpreadStart(numPages: number, coverOffset: boolean): number {
  return Math.max(1, getSpreadStart(numPages, coverOffset));
}

/**
 * 上一页目标：单页 -1；双页回到上一 spread 首页（对齐行首）。
 * 已在首页/首个 spread 时原地返回。
 */
export function getPrevNavigationPage(
  currentPage: number,
  viewMode: PdfViewMode,
  numPages: number,
  coverOffset = false,
): number {
  if (numPages <= 0) return currentPage;
  if (viewMode === 'dual') {
    const start = getSpreadStart(currentPage, coverOffset);
    if (coverOffset && start === 2) return 1;
    return Math.max(1, start - 2);
  }
  return Math.max(1, Math.min(currentPage, numPages) - 1);
}

/**
 * 下一页目标：单页 +1；双页跳到下一 spread 首页（对齐行首）。
 * 已在末页/末 spread 时原地返回（双页下不塌缩到同 spread 的次页，
 * 避免页码变了视图却没动）。
 */
export function getNextNavigationPage(
  currentPage: number,
  viewMode: PdfViewMode,
  numPages: number,
  coverOffset = false,
): number {
  if (numPages <= 0) return currentPage;
  if (viewMode === 'dual') {
    const start = getSpreadStart(currentPage, coverOffset);
    const next = coverOffset && start === 1 ? 2 : start + 2;
    return Math.min(getLastSpreadStart(numPages, coverOffset), next);
  }
  return Math.min(numPages, Math.max(currentPage, 1) + 1);
}

/** 工具栏「上一页」是否可用（双页下首个 spread 内的任意页都视为顶端）。 */
export function canNavigatePrev(
  currentPage: number,
  viewMode: PdfViewMode,
  coverOffset = false,
): boolean {
  return viewMode === 'dual'
    ? getSpreadStart(currentPage, coverOffset) > 1
    : currentPage > 1;
}

/** 工具栏「下一页」是否可用（双页下末 spread 的行首页即为末端）。 */
export function canNavigateNext(
  currentPage: number,
  viewMode: PdfViewMode,
  numPages: number,
  coverOffset = false,
): boolean {
  if (numPages <= 0) return false;
  return viewMode === 'dual'
    ? getSpreadStart(currentPage, coverOffset) < getLastSpreadStart(numPages, coverOffset)
    : currentPage < numPages;
}

export type PageScrollKeyAction = 'scroll' | 'navigate';

/**
 * PageUp / PageDown 的语义裁决：
 * - 页面放大到一屏放不下（渲染高度 > 视口高度）时按「滚一屏」处理——
 *   直接跳页会整段跳过当前页的未读部分（Acrobat/pdf.js 同语义）；
 * - 页面完整可见时按「翻页」处理（双页模式按 spread 步进）。
 * ←/→ 不走本函数，始终是翻页。
 */
export function resolvePageScrollKeyAction(
  pageHeightPx: number,
  viewportHeightPx: number,
): PageScrollKeyAction {
  if (!Number.isFinite(pageHeightPx) || !Number.isFinite(viewportHeightPx)) {
    return 'navigate';
  }
  if (pageHeightPx <= 0 || viewportHeightPx <= 0) return 'navigate';
  return pageHeightPx > viewportHeightPx + 1 ? 'scroll' : 'navigate';
}
