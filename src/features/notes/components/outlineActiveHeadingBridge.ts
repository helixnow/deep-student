/**
 * 编辑器 → 大纲面板的"当前标题"广播契约。
 *
 * NotesCrepeEditor 在滚动时（rAF 节流）计算视口顶部附近的标题并派发；
 * NotesContextPanel 监听后高亮对应大纲行。occurrence 用于同名同级标题去歧义
 * （文档顺序中第几个同文本标题）。
 */

export const NOTES_ACTIVE_HEADING_EVENT = 'notes:active-heading-changed';

export interface NotesActiveHeadingDetail {
  noteId: string;
  /** 标题渲染后的纯文本（未小写化） */
  text: string;
  /** 1-6 */
  level: number;
  /** 同文本同级标题中的序号（0 起） */
  occurrence: number;
}

/** 与 NotesContextPanel 的 searchText 口径对齐的宽松归一化 */
export const normalizeActiveHeadingText = (raw: string): string =>
  raw.replace(/\s+/g, ' ').trim().toLowerCase();
