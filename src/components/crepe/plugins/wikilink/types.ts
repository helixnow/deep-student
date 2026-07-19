/**
 * Wikilink 插件类型与事件契约
 */

import type { DstuOpenNoteDetail } from '@/features/notes/openNoteEvent';

/** 补全候选笔记（与 NotesSearchOverlay / DSTU note 字段对齐的最小子集） */
export interface WikilinkNoteCandidate {
  id: string;
  title: string;
}

export interface WikilinkResolveResult {
  /** false → unresolved（虚线 + 半透明） */
  resolved: boolean;
  /** 已解析时用于 DSTU_OPEN_NOTE 的 noteId；缺省则回退为 target */
  noteId?: string | null;
}

/**
 * 判定 target 是否已解析。
 * - boolean：简写
 * - WikilinkResolveResult：可附带 noteId
 *
 * 默认（未注入）：全部按已解析渲染。
 */
export type WikilinkResolver = (
  target: string,
) => boolean | WikilinkResolveResult;

export interface WikilinkPluginConfig {
  /**
   * 解析回调。接线时建议基于 createWikiLinkIndex(notes).resolve。
   * 未提供时默认全部 resolved。
   */
  resolve?: WikilinkResolver;
  /**
   * 补全数据源：返回当前可用笔记标题列表。
   * 接线时建议注入 NotesSearchOverlay 同源的 in-memory resources，
   * 或 notesDstuAdapter.listNotes / searchNotes 的结果映射。
   */
  getNotes?: () =>
    | readonly WikilinkNoteCandidate[]
    | Promise<readonly WikilinkNoteCandidate[]>;
  /** 补全最多展示条数（不含「创建」项），默认 8 */
  maxSuggestions?: number;
}

/** 窗口事件名（复用既有打开机制 + 新建契约） */
export const WIKILINK_EVENTS = {
  /** 已解析点击 → 打开笔记（detail: { noteId, source: 'wikilink', target }） */
  OPEN_NOTE: 'DSTU_OPEN_NOTE',
  /** 未解析点击 → 请求按标题创建（detail: { title }） */
  CREATE_FROM_WIKILINK: 'notes:create-from-wikilink',
} as const;

export function normalizeResolve(
  resolve: WikilinkResolver | undefined,
  target: string,
): WikilinkResolveResult {
  if (!resolve) {
    return { resolved: true, noteId: target };
  }
  const result = resolve(target);
  if (typeof result === 'boolean') {
    return { resolved: result, noteId: result ? target : null };
  }
  return {
    resolved: result.resolved,
    noteId: result.noteId ?? (result.resolved ? target : null),
  };
}

export function dispatchOpenNote(target: string, noteId: string, heading?: string): void {
  window.dispatchEvent(
    new CustomEvent<DstuOpenNoteDetail>(WIKILINK_EVENTS.OPEN_NOTE, {
      detail: { noteId, source: 'wikilink', target, ...(heading ? { heading } : {}) },
    }),
  );
}

export function dispatchCreateFromWikilink(title: string): void {
  window.dispatchEvent(
    new CustomEvent(WIKILINK_EVENTS.CREATE_FROM_WIKILINK, {
      detail: { title },
    }),
  );
}
