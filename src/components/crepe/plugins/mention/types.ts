/**
 * @ 提及笔记插件：类型与事件契约
 */

import type { DstuOpenNoteDetail } from '@/features/notes/openNoteEvent';

/** 补全候选（与接线侧 / DSTU note 字段对齐的最小子集） */
export interface MentionNoteCandidate {
  id: string;
  title: string;
}

/**
 * 搜索回调。返回匹配笔记列表。
 * 接线代理可注入内存索引 / NotesSearchOverlay 同源数据，覆盖默认 DSTU 实现。
 */
export type MentionSearchNotes = (
  query: string,
) => Promise<readonly MentionNoteCandidate[]> | readonly MentionNoteCandidate[];

export interface MentionPluginConfig {
  /** 搜索数据源；未提供时使用 defaultSearchNotes（DSTU searchNotes） */
  searchNotes?: MentionSearchNotes;
  /** 补全最多展示条数，默认 8 */
  maxSuggestions?: number;
  /** 查询防抖毫秒，默认 150 */
  debounceMs?: number;
}

/** 窗口事件（复用既有打开机制） */
export const MENTION_EVENTS = {
  /** 点击 note:// 链接 → 打开笔记（detail: { noteId, source: 'mention' }） */
  OPEN_NOTE: 'DSTU_OPEN_NOTE',
} as const;

export const NOTE_HREF_PROTOCOL = 'note://';

export function dispatchOpenMentionNote(noteId: string): void {
  window.dispatchEvent(
    new CustomEvent<DstuOpenNoteDetail>(MENTION_EVENTS.OPEN_NOTE, {
      detail: { noteId, source: 'mention' },
    }),
  );
}
