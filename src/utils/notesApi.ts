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
  /** 版本历史已移除（V20260214），恒为 0，仅为兼容保留 */
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

export const NotesAPI = {
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
   * 注意：includeVersions 已废弃 —— 版本历史表已删除（V20260214），
   * 该开关不再产生任何版本数据，仅为兼容旧调用保留。
   */
  async exportNotes(options: { outputPath?: string; includeVersions?: boolean } = {}): Promise<NotesExportSummary> {
    const payload = {
      output_path: options.outputPath,
      // @deprecated 版本历史已移除，此参数不再生效
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
   * 注意：includeVersions 已废弃（同 exportNotes）。
   */
  async exportSingleNote(options: { noteId: string; outputPath?: string; includeVersions?: boolean }): Promise<NotesExportSummary> {
    const payload = {
      // ★ P0-1 契约修复：后端 request.subject 原为必填，补传 '_global'
      subject: GLOBAL_SUBJECT,
      note_id: options.noteId,
      output_path: options.outputPath,
      // @deprecated 版本历史已移除，此参数不再生效
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
