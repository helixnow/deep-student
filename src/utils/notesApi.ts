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
 *
 * @see src/dstu/adapters/notesDstuAdapter.ts for CRUD operations
 * @see src/components/notes/NotesContext.tsx for DSTU integration
 */
import { invoke } from '@tauri-apps/api/core';

export type NoteItem = {
  id: string;
  title: string;
  content_md: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
};

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

  async saveAsset(noteId: string, base64Data: string, defaultExt?: string): Promise<{ absolute_path: string; relative_path: string }>{
    return await invoke<any>('notes_save_asset', { 
      subject: '_global',
      noteId,
      base64Data,
      defaultExt,
    });
  },

  // ★ 2026-01 清理：getMappedDocId, getNoteIdByDocumentId, getNoteIdsByDocumentIds, getRagChunkText 已移除

  async listAssets(noteId: string): Promise<Array<{ absolute_path: string; relative_path: string }>> {
    return await invoke<any[]>('notes_list_assets', { subject: '_global', noteId }) as any;
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
    return await invoke<any>('notes_get_pref', { key }) as any;
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

  async dbStats(): Promise<{ db_path: string; file_size_bytes: number; total_notes: number; total_versions: number; total_assets: number }>{
    return await invoke<any>('notes_db_stats', {});
  },
  async dbVacuum(): Promise<boolean> {
    return await invoke<boolean>('notes_db_vacuum', {});
  },

  async listTags(): Promise<string[]> {
    return await invoke<string[]>('notes_list_tags', {});
  },

  /**
   * @deprecated Tag renaming should be done via DSTU API
   * This method is kept for backward compatibility but may not work correctly
   */
  async renameTag(oldName: string, newName: string): Promise<void> {
    console.warn('[NotesAPI] renameTag is deprecated - use DSTU API for note operations');
    // This function requires CRUD operations which have been removed
    // Keeping stub for compatibility but it won't work
    throw new Error('renameTag is no longer supported - please use DSTU API');
  },

  async searchNotesByTag(tag: string, limit: number = 50): Promise<Array<{ id: string; title: string; snippet?: string }>> {
    return await invoke<any>('notes_search', {
      keyword: `tag:${tag}`,
      limit
    }) as any;
  },

  async listDeleted(page: number = 0, page_size: number = 20): Promise<{ items: NoteItem[]; total: number; page: number; page_size: number }> {
    return await invoke<any>('notes_list_deleted', { page, page_size }) as any;
  },
  async emptyTrash(): Promise<number> {
    return await invoke<number>('notes_empty_trash', {});
  },
  async hardDelete(id: string): Promise<boolean> {
    return await invoke<boolean>('notes_hard_delete', { id });
  },
  async restore(id: string): Promise<boolean> {
    return await invoke<boolean>('notes_restore', { id });
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
    return await invoke<number>('notes_assets_index_scan', { noteId });
  },
  async scanOrphanAssets(): Promise<string[]> {
    return await invoke<string[]>('notes_assets_scan_orphans', {});
  },
  async bulkDeleteAssets(paths: string[]): Promise<number> {
    return await invoke<number>('notes_assets_bulk_delete', { paths });
  },
  /**
   * 导出笔记库为统一 ZIP 格式（Markdown + 元数据）
   * 该格式兼容常见 Markdown 编辑器
   */
  async exportNotes(options: { outputPath?: string; includeVersions?: boolean } = {}): Promise<{
    output_path: string;
    note_count: number;
    attachment_count: number;
  }> {
    const payload = {
      output_path: options.outputPath,
      include_versions: options.includeVersions ?? true,
    };
    try {
      const result = await invoke<{
        output_path: string;
        note_count: number;
        attachment_count: number;
      }>('notes_export', { request: payload });
      return result;
    } catch (error: unknown) {
      console.error('[NotesAPI] exportNotes failed:', error);
      throw error;
    }
  },
  /**
   * 导出单条笔记为统一 ZIP 格式
   */
  async exportSingleNote(options: { noteId: string; outputPath?: string; includeVersions?: boolean }): Promise<{
    output_path: string;
    note_count: number;
    attachment_count: number;
  }> {
    const payload = {
      note_id: options.noteId,
      output_path: options.outputPath,
      include_versions: options.includeVersions ?? true,
    };
    try {
      const result = await invoke<{
        output_path: string;
        note_count: number;
        attachment_count: number;
      }>('notes_export_single', { request: payload });
      return result;
    } catch (error: unknown) {
      console.error('[NotesAPI] exportSingleNote failed:', error);
      throw error;
    }
  },
  async importNotes(options: { 
    filePath: string;
    conflictStrategy?: 'skip' | 'overwrite' | 'merge_keep_newer';
  }): Promise<{
    note_count: number;
    attachment_count: number;
    skipped_count: number;
    overwritten_count: number;
  }> {
    const payload = {
      file_path: options.filePath,
      conflict_strategy: options.conflictStrategy,
    };
    try {
      const result = await invoke<{
        note_count: number;
        attachment_count: number;
        skipped_count: number;
        overwritten_count: number;
      }>('notes_import', { request: payload });
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
    return await invoke<string>('canvas_note_read', { noteId, section });
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
    await invoke<void>('canvas_note_append', { noteId, content, section });
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
    return await invoke<number>('canvas_note_replace', { noteId, search, replace, isRegex });
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
    await invoke<void>('canvas_note_set', { noteId, content });
  },
};
