/**
 * Notes API - Utility Functions Only
 *
 * CRUD operations have been migrated to DSTU API.
 * This module contains only utility functions that don't have DSTU equivalents:
 * - Preferences (getPref, setPref)
 * - Assets (saveAsset, listAssets, deleteAsset, etc.)
 * - Import/Export (exportNotes, importNotes)
 * - Tags, Trash, and other utilities
 * 
 * ★ 2026-01 清理：notes_rag_* 操作已移除，VFS RAG 完全替代
 * ★ 2026-07 契约修复：所有需要 subject 的命令统一补传 '_global'（后端同步改为
 *   Option 默认 '_global'，双保险）；invoke<any> 全部替换为具体返回类型。
 *
 * @see src/dstu/adapters/notesDstuAdapter.ts for CRUD operations
 * @see src/features/notes/NotesContext.tsx for DSTU integration
 */
import { invoke } from '@tauri-apps/api/core';
import type { DstuNode } from '@/dstu/types';
import type { NoteLeaseAuth } from '@/features/notes/noteHostCoordinator';

/** 默认学科分区：笔记资产/命令统一使用的占位 subject */
const GLOBAL_SUBJECT = '_global';

export type NoteItem = {
  id: string;
  title: string;
  content_md: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
};

/** 笔记资产条目（绝对路径 + 相对路径） */
export interface NoteAssetInfo {
  absolute_path: string;
  relative_path: string;
}

/** notes_db_stats 返回结构 */
export interface NotesDbStats {
  db_path: string;
  file_size_bytes: number;
  total_notes: number;
  /** 本地完整文档历史版本数 */
  total_versions: number;
  /** notes_assets 目录下文件总数 */
  total_assets: number;
  /** notes_assets 目录下文件总字节数 */
  total_asset_bytes: number;
}

/** notes_search 命中项 */
export interface NotesSearchHit {
  id: string;
  title: string;
  snippet?: string | null;
}

/** notes_list_deleted 返回结构（NotesListAdvancedResponse） */
export interface NotesTrashPage {
  items: NoteItem[];
  total: number;
  page: number;
  page_size: number;
}

/** notes_export / notes_export_single 返回结构 */
export interface NotesExportSummary {
  output_path: string;
  note_count: number;
  attachment_count: number;
}

/** notes_import 返回结构 */
export interface NotesImportSummary {
  note_count: number;
  attachment_count: number;
  skipped_count: number;
  overwritten_count: number;
}

// ★ 2026-01 清理：NotesRagSubjectStatus 和 NotesRagQueryOptions 已移除，VFS RAG 完全替代

export interface NotesMentionIrecCardHit {
  id: string;
  title: string;
  insight: string;
  tags: string[];
  mistake_id?: string | null;
}

export interface NotesMentionSearchResult {
  irec_cards: NotesMentionIrecCardHit[];
}

// ★ 2026-02 清理：NoteOutgoingLink, NoteLinksResult 已移除
// note_links 系统在 VFS 模式下不维护，getLinks/listVectorStatus 后端命令不存在

export interface NoteHistorySummary {
  version_id: string;
  note_id: string;
  parent_version_id: string | null;
  restored_from_version_id: string | null;
  title: string;
  source: string;
  created_at: string;
  pinned: boolean;
  content_bytes: number;
}

export interface NoteHistoryRevision extends NoteHistorySummary {
  content_md: string;
  tags: string[];
  props: Record<string, string | number | boolean> | null;
  asset_refs: Array<{ kind: 'notes_asset' | 'external_resource' | 'remote_url'; value: string }>;
  content_format: string;
  format_version: number;
  serializer_version: string;
}

export interface NoteHistoryPage {
  items: NoteHistorySummary[];
  next_cursor: number | null;
}

/** Inclusive, one-based source lines. Backend slices the immutable version. */
export interface NoteHistorySelection { start_line: number; end_line: number }
export interface NoteHistoryCurrent {
  content_md: string;
  updated_at: string;
  title: string;
}
export interface NoteHistoryRetention {
  /** 0 disables edit coalescing. Pins and migration baselines are exempt. */
  edit_bucket_seconds: number;
  /** null means keep all ordinary edit versions. */
  max_edit_versions: number | null;
}

export const NotesAPI = {
  async historyList(noteId: string, cursor?: number | null, limit = 30, pinnedOnly = false): Promise<NoteHistoryPage> {
    return invoke<NoteHistoryPage>('notes_history_list', { noteId, cursor: cursor ?? null, limit, pinnedOnly });
  },
  /** 只读预览；可能被合并的普通版本可通过 historySetPinned 主动保留。 */
  async historyGet(noteId: string, versionId: string): Promise<NoteHistoryRevision> {
    return invoke<NoteHistoryRevision>('notes_history_get', { noteId, versionId });
  },
  /** 解除固定不立即删除版本或附件；也可管理旧预览和恢复操作产生的本地保留。 */
  async historySetPinned(noteId: string, versionId: string, pinned: boolean): Promise<NoteHistorySummary> {
    return invoke<NoteHistorySummary>('notes_history_set_pinned', { noteId, versionId, pinned });
  },
  /** 创建资源库根目录副本，返回可供宿主打开的 DSTU 节点；原文与草稿不变。 */
  async historyRestoreCopy(noteId: string, versionId: string, selection?: NoteHistorySelection): Promise<DstuNode> {
    // Use a distinct command: older Tauri handlers ignore extra arguments, which
    // would silently restore the whole document when selection is unsupported.
    return selection
      ? invoke<DstuNode>('notes_history_restore_selection_copy', { noteId, versionId, selection })
      : invoke<DstuNode>('notes_history_restore_copy', { noteId, versionId });
  },
  async historyCurrent(noteId: string): Promise<NoteHistoryCurrent> {
    return invoke<NoteHistoryCurrent>('notes_history_current', { noteId });
  },
  /** Atomic CAS + pinned before_restore snapshot; selection replaces the current
   * document with the selected historical lines, as shown in the preview. */
  async historyRestoreCurrent(noteId: string, versionId: string, expectedUpdatedAt: string, selection?: NoteHistorySelection, lease?: NoteLeaseAuth): Promise<DstuNode> {
    return invoke<DstuNode>('notes_history_restore_current', { noteId, versionId, expectedUpdatedAt, selection: selection ?? null, ...(lease ? { lease } : {}) });
  },
  async historyGetRetention(): Promise<NoteHistoryRetention> {
    return invoke<NoteHistoryRetention>('notes_history_get_retention');
  },
  async historySetRetention(policy: NoteHistoryRetention): Promise<NoteHistoryRetention> {
    return invoke<NoteHistoryRetention>('notes_history_set_retention', { policy });
  },
  // ★ 2026-01 清理：RAG Operations 已移除，VFS RAG 完全替代
  // ragInspectSubject, ragAddFromContent, ragUpdateContent, ragQuery,
  // ragDeleteDocument, ragReembedDocument, ragReembedAll, ragMigrateFilenames,
  // ragGetStatus, ragListSubjectStatuses 均已废弃

  async saveAsset(noteId: string, base64Data: string, defaultExt?: string): Promise<NoteAssetInfo> {
    return await invoke<NoteAssetInfo>('notes_save_asset', {
      subject: GLOBAL_SUBJECT,
      noteId,
      base64Data,
      defaultExt,
    });
  },

  // ★ 2026-01 清理：getMappedDocId, getNoteIdByDocumentId, getNoteIdsByDocumentIds, getRagChunkText 已移除

  async listAssets(noteId: string): Promise<NoteAssetInfo[]> {
    return await invoke<NoteAssetInfo[]>('notes_list_assets', { subject: GLOBAL_SUBJECT, noteId });
  },

  // ★ 2026-02 清理：getLinks (notes_get_links) 已移除，后端命令不存在
  // ★ 2026-02 清理：listVectorStatus (notes_vector_status_list) 已移除，后端命令不存在

  async deleteAsset(relativePath: string): Promise<boolean> {
    // Tauri v2 将 snake_case 参数名转换为 camelCase
    return await invoke<boolean>('notes_delete_asset', { relativePath });
  },

  async resolveAssetPath(relativePath: string): Promise<string> {
    // Tauri v2 将 snake_case 参数名转换为 camelCase
    return await invoke<string>('notes_resolve_asset_path', { relativePath });
  },

  // ★ 2026-01 清理：ragUpsertFromContent, getRagConfig, updateRagConfig 已移除

  async setPref(key: string, value: string): Promise<boolean> {
    return await invoke<boolean>('notes_set_pref', { key, value });
  },
  async getPref(key: string): Promise<string | null> {
    return await invoke<string | null>('notes_get_pref', { key });
  },
  async saveNoteAnnotations(noteId: string, annotations: Array<{ id: string; text: string; author?: string; ts?: string }>): Promise<boolean> {
    const key = `note_annotations:${noteId}`;
    return await NotesAPI.setPref(key, JSON.stringify(annotations || []));
  },
  async loadNoteAnnotations(noteId: string): Promise<Array<{ id: string; text: string; author?: string; ts?: string }>> {
    const key = `note_annotations:${noteId}`;
    const val = await NotesAPI.getPref(key);
    if (!val) return [];
    try { return JSON.parse(val); } catch { return []; }
  },

  async dbStats(): Promise<NotesDbStats> {
    return await invoke<NotesDbStats>('notes_db_stats', {});
  },
  async dbVacuum(): Promise<boolean> {
    return await invoke<boolean>('notes_db_vacuum', {});
  },

  async listTags(): Promise<string[]> {
    return await invoke<string[]>('notes_list_tags', { subject: GLOBAL_SUBJECT });
  },

  /**
   * @deprecated Tag renaming should be done via NotesContext.renameTagAcrossNotes
   * (DSTU-based)。本方法无真实调用方，仅为兼容旧引用保留；调用将直接抛错。
   */
  async renameTag(oldName: string, newName: string): Promise<void> {
    console.warn('[NotesAPI] renameTag is deprecated - use NotesContext.renameTagAcrossNotes (DSTU) instead');
    throw new Error(
      `renameTag('${oldName}' -> '${newName}') is no longer supported here: ` +
      'note CRUD has moved to the DSTU API. Use NotesContext.renameTagAcrossNotes instead.'
    );
  },

  async searchNotesByTag(tag: string, limit: number = 50): Promise<NotesSearchHit[]> {
    return await invoke<NotesSearchHit[]>('notes_search', {
      subject: GLOBAL_SUBJECT,
      keyword: `tag:${tag}`,
      limit,
    });
  },

  async listDeleted(page: number = 0, page_size: number = 20): Promise<NotesTrashPage> {
    return await invoke<NotesTrashPage>('notes_list_deleted', { subject: GLOBAL_SUBJECT, page, page_size });
  },
  async emptyTrash(): Promise<number> {
    return await invoke<number>('notes_empty_trash', { subject: GLOBAL_SUBJECT });
  },
  async hardDelete(id: string): Promise<boolean> {
    return await invoke<boolean>('notes_hard_delete', { subject: GLOBAL_SUBJECT, id });
  },
  async restore(id: string): Promise<boolean> {
    return await invoke<boolean>('notes_restore', { subject: GLOBAL_SUBJECT, id });
  },
  async mentionsSearch(keyword: string, options?: { limit?: number }): Promise<NotesMentionSearchResult> {
    const payload: Record<string, unknown> = {
      keyword,
    };
    if (typeof options?.limit === 'number') {
      payload.limit = options.limit;
    }
    const res = await invoke<NotesMentionSearchResult>('notes_mentions_search', payload);
    return {
      irec_cards: res?.irec_cards ?? [],
    };
  },
  async indexAssets(noteId: string): Promise<number> {
    return await invoke<number>('notes_assets_index_scan', { subject: GLOBAL_SUBJECT, noteId });
  },
  async scanOrphanAssets(): Promise<string[]> {
    return await invoke<string[]>('notes_assets_scan_orphans', { subject: GLOBAL_SUBJECT });
  },
  async bulkDeleteAssets(paths: string[]): Promise<number> {
    return await invoke<number>('notes_assets_bulk_delete', { paths });
  },
  /**
   * 导出笔记库为统一 ZIP 格式（Markdown + 元数据）
   * 该格式兼容常见 Markdown 编辑器
   *
   * includeVersions 包含全部保留历史、版本血缘和历史引用附件。
   */
  async exportNotes(options: { outputPath?: string; includeVersions?: boolean } = {}): Promise<NotesExportSummary> {
    const payload = {
      output_path: options.outputPath,
      include_versions: options.includeVersions ?? true,
    };
    try {
      const result = await invoke<NotesExportSummary>('notes_export', { request: payload });
      return result;
    } catch (error: unknown) {
      console.error('[NotesAPI] exportNotes failed:', error);
      throw error;
    }
  },
  /**
   * 导出单条笔记为统一 ZIP 格式
   *
   * includeVersions 默认包含全部保留历史（同 exportNotes）。
   */
  async exportSingleNote(options: { noteId: string; outputPath?: string; includeVersions?: boolean }): Promise<NotesExportSummary> {
    const payload = {
      // ★ P0-1 契约修复：后端 request.subject 原为必填，补传 '_global'
      subject: GLOBAL_SUBJECT,
      note_id: options.noteId,
      output_path: options.outputPath,
      include_versions: options.includeVersions ?? true,
    };
    try {
      const result = await invoke<NotesExportSummary>('notes_export_single', { request: payload });
      return result;
    } catch (error: unknown) {
      console.error('[NotesAPI] exportSingleNote failed:', error);
      throw error;
    }
  },
  async importNotes(options: { 
    filePath: string;
    conflictStrategy?: 'skip' | 'overwrite' | 'merge_keep_newer';
  }): Promise<NotesImportSummary> {
    const payload = {
      file_path: options.filePath,
      conflict_strategy: options.conflictStrategy,
    };
    try {
      const result = await invoke<NotesImportSummary>('notes_import', { request: payload });
      return result;
    } catch (error: unknown) {
      console.error('[NotesAPI] importNotes failed:', error);
      throw error;
    }
  },

  // ========== Canvas 扩展（AI 操作笔记） ==========

  /**
   * 读取笔记内容（Canvas AI 工具使用）
   * @param noteId 笔记 ID
   * @param section 可选，只读取指定章节标题（如 '## 代码实现'）
   * @returns 笔记内容字符串
   */
  async canvasReadContent(
    noteId: string,
    section?: string
  ): Promise<string> {
    return await invoke<string>('canvas_note_read', { subject: GLOBAL_SUBJECT, noteId, section });
  },

  /**
   * 追加内容到笔记（Canvas AI 工具使用）
   * @param noteId 笔记 ID
   * @param content 要追加的内容
   * @param section 可选，追加到指定章节末尾
   */
  async canvasAppendContent(
    noteId: string,
    content: string,
    section?: string
  ): Promise<void> {
    await invoke<void>('canvas_note_append', { subject: GLOBAL_SUBJECT, noteId, content, section });
  },

  /**
   * 替换笔记内容（Canvas AI 工具使用）
   * @param noteId 笔记 ID
   * @param search 查找文本
   * @param replace 替换文本
   * @param isRegex 是否使用正则表达式
   * @returns 替换次数
   */
  async canvasReplaceContent(
    noteId: string,
    search: string,
    replace: string,
    isRegex?: boolean
  ): Promise<number> {
    return await invoke<number>('canvas_note_replace', { subject: GLOBAL_SUBJECT, noteId, search, replace, isRegex });
  },

  /**
   * 设置笔记完整内容（Canvas AI 工具使用，谨慎使用）
   * @param noteId 笔记 ID
   * @param content 新的完整内容
   */
  async canvasSetContent(
    noteId: string,
    content: string
  ): Promise<void> {
    await invoke<void>('canvas_note_set', { subject: GLOBAL_SUBJECT, noteId, content });
  },
};
