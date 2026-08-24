/**
 * PDF 划词动作纯函数（对标 MarginNote 的划词入口）
 *
 * 动作本体（复制 / 引用到对话 / 做笔记）由上层视图注入回调；
 * 这里只放可单测的纯逻辑：引用 locator、摘录笔记内容、菜单视口钳位。
 */

/** 划词动作载荷（划词菜单 → 视图回调） */
export interface PdfSelectionPayload {
  /** 选中的原文（已 trim） */
  text: string;
  /** 所在页码（1-based） */
  page: number;
}

/**
 * 引用到对话使用的 locator（与 FilePreviewAppWindow 的
 * `slide:N` / `line:N` / EPUB `chapter:N` 约定同族）。
 */
export function buildSelectionLocator(page: number): string {
  return `page:${page}`;
}

/** 选中文本 → markdown 引用块（逐行加 `> `，保留段内换行） */
export function formatSelectionQuoteBlock(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * 摘录笔记正文：引用块 + 来源行。
 * sourceLabel 由调用方用 i18n 生成（如「来源：《x.pdf》第 3 页」）。
 */
export function buildSelectionNoteContent(input: {
  text: string;
  sourceLabel: string;
}): string {
  return `${formatSelectionQuoteBlock(input.text)}\n\n${input.sourceLabel}\n`;
}

// ============================================================================
// 浮动菜单视口钳位
// ============================================================================

/** 菜单锚点：选区（或高亮块）的水平中点与上下边缘（viewport 坐标） */
export interface SelectionMenuAnchor {
  x: number;
  top: number;
  bottom: number;
}

export interface SelectionMenuFrame {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

/**
 * 把浮动菜单钳位到视口内：
 * - 优先放在锚点上方（间距 offset）；顶部放不下时翻转到锚点下方；
 * - 水平/垂直方向都 clamp 进 [margin, viewport - margin - menuSize]。
 * 返回的坐标为菜单左上角（position: fixed，无 transform）。
 */
export function resolveSelectionMenuFrame(
  anchor: SelectionMenuAnchor,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  options?: { offset?: number; margin?: number },
): SelectionMenuFrame {
  const offset = options?.offset ?? 10;
  const margin = options?.margin ?? 8;

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));

  const left = clamp(
    anchor.x - menu.width / 2,
    margin,
    viewport.width - margin - menu.width,
  );

  const aboveTop = anchor.top - offset - menu.height;
  if (aboveTop >= margin) {
    return {
      left,
      top: clamp(aboveTop, margin, viewport.height - margin - menu.height),
      placement: 'above',
    };
  }

  const belowTop = clamp(
    anchor.bottom + offset,
    margin,
    viewport.height - margin - menu.height,
  );
  return { left, top: belowTop, placement: 'below' };
}
