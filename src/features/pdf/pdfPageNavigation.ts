/**
 * PDF 翻页导航纯函数
 *
 * 双页（spread）模式下页面按 [1,2] [3,4] … 成对排布（奇数页为行首）。
 * 单页步进 ±1 在双页模式下会落进同一 spread，视觉上毫无变化——
 * 翻页必须以 spread 为单位步进 ±2，并对齐到 spread 首页。
 *
 * 仅覆盖「翻页」语义（←/→、PageUp/PageDown、工具栏按钮）；
 * 空格滚屏走视口 scrollBy，与此处无关。
 */

export type PdfViewMode = 'single' | 'dual';

/** 页码所在 spread 的首页（双页配对 [1,2] [3,4] …，奇数页为行首）。 */
export function getSpreadStart(page: number): number {
  return page - ((page - 1) % 2);
}

/** 最后一个 spread 的首页（= 可跳转的最大目标页）。 */
function getLastSpreadStart(numPages: number): number {
  return Math.max(1, getSpreadStart(numPages));
}

/**
 * 上一页目标：单页 -1；双页回到上一 spread 首页（-2，且对齐行首）。
 * 已在首页/首个 spread 时原地返回。
 */
export function getPrevNavigationPage(
  currentPage: number,
  viewMode: PdfViewMode,
  numPages: number,
): number {
  if (numPages <= 0) return currentPage;
  if (viewMode === 'dual') {
    return Math.max(1, getSpreadStart(currentPage) - 2);
  }
  return Math.max(1, Math.min(currentPage, numPages) - 1);
}

/**
 * 下一页目标：单页 +1；双页跳到下一 spread 首页（+2，且对齐行首）。
 * 已在末页/末 spread 时原地返回（双页下不塌缩到同 spread 的偶数页，
 * 避免页码变了视图却没动）。
 */
export function getNextNavigationPage(
  currentPage: number,
  viewMode: PdfViewMode,
  numPages: number,
): number {
  if (numPages <= 0) return currentPage;
  if (viewMode === 'dual') {
    return Math.min(getLastSpreadStart(numPages), getSpreadStart(currentPage) + 2);
  }
  return Math.min(numPages, Math.max(currentPage, 1) + 1);
}

/** 工具栏「上一页」是否可用（双页下首个 spread 内的第 2 页也视为顶端）。 */
export function canNavigatePrev(currentPage: number, viewMode: PdfViewMode): boolean {
  return viewMode === 'dual' ? getSpreadStart(currentPage) > 1 : currentPage > 1;
}

/** 工具栏「下一页」是否可用（双页下末 spread 的行首页即为末端）。 */
export function canNavigateNext(
  currentPage: number,
  viewMode: PdfViewMode,
  numPages: number,
): boolean {
  if (numPages <= 0) return false;
  return viewMode === 'dual'
    ? getSpreadStart(currentPage) < getLastSpreadStart(numPages)
    : currentPage < numPages;
}
