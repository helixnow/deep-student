/**
 * 笔记模块 DSTU 适配器
 *
 * 提供笔记模块从 NotesAPI 迁移到 DSTU API 的适配层。
 *
 * 使用方式：
 * ```typescript
 * // 方式 1：使用 DSTU Hook（推荐）
 * const { notes, loading, refresh } = useNotesDstu();
 *
 * // 方式 2：直接调用适配器
 * const notes = await notesDstuAdapter.listNotes();
 * ```
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 10
 */

import i18next from 'i18next';
import { dstu } from '../api';
import { pathUtils } from '../utils/pathUtils';
import type { DstuNode, DstuNodeType, DstuListOptions } from '../types';
import type { NoteItem } from '@/utils/notesApi';
import { Result, VfsError, ok, err, reportError, toVfsError } from '@/shared/result';

// ============================================================================
// 配置
// ============================================================================

const LOG_PREFIX = '[NotesDSTU]';

// ============================================================================
// 类型转换
// ============================================================================

/**
 * 将 DstuNode 转换为 NoteItem
 *
 * 保持与现有代码的兼容性
 */
export function dstuNodeToNoteItem(node: DstuNode): NoteItem {
  return {
    id: node.id,
    title: node.name,
    content_md: '', // 内容需要单独加载
    tags: (node.metadata?.tags as string[]) || [],
    created_at: new Date(node.createdAt).toISOString(),
    updated_at: new Date(node.updatedAt).toISOString(),
    is_favorite: Boolean(node.metadata?.isFavorite),
  };
}

/**
 * 将 NoteItem 转换为 DstuNode
 */
export function noteItemToDstuNode(note: NoteItem): DstuNode {
  return {
    id: note.id,
    sourceId: note.id,
    path: `/${note.id}`,
    name: note.title || i18next.t('dstu:adapters.notes.untitled'),
    type: 'note',
    size: note.content_md?.length || 0,
    createdAt: new Date(note.created_at).getTime(),
    updatedAt: new Date(note.updated_at).getTime(),
    // resourceId 和 resourceHash 从后端获取，前端适配器暂不填
    previewType: 'markdown',
    metadata: {
      tags: note.tags,
      isFavorite: note.is_favorite,
    },
  };
}

// ============================================================================
// 适配器实现
// ============================================================================

/**
 * 笔记 DSTU 适配器
 *
 * 提供 DSTU 语义的笔记操作接口
 */
export const notesDstuAdapter = {
  /**
   * 列出笔记
   *
   * @param options 列表选项
   * @returns 笔记节点数组
   */
  async listNotes(options?: DstuListOptions): Promise<Result<DstuNode[], VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'listNotes via DSTU:', path, 'typeFilter: note');
    const result = await dstu.list(path, { ...options, typeFilter: 'note' });
    if (!result.ok) {
      reportError(result.error, 'List notes');
    }
    return result;
  },

  /**
   * 获取笔记详情
   *
   * @param noteId 笔记 ID
   * @returns 笔记节点
   */
  async getNote(noteId: string): Promise<Result<DstuNode | null, VfsError>> {
    const path = `/${noteId}`;
    console.log(LOG_PREFIX, 'getNote via DSTU:', path);
    const result = await dstu.get(path);
    if (!result.ok) {
      reportError(result.error, 'Get note detail');
    }
    return result;
  },

  /**
   * 获取笔记内容
   *
   * @param noteId 笔记 ID
   * @returns 笔记 Markdown 内容
   */
  async getNoteContent(noteId: string): Promise<Result<string, VfsError>> {
    const path = `/${noteId}`;
    console.log(LOG_PREFIX, 'getNoteContent via DSTU:', path);
    const result = await dstu.getContent(path);
    if (!result.ok) {
      reportError(result.error, 'Get note content');
      return err(result.error);
    }
    return ok(typeof result.value === 'string' ? result.value : '');
  },

  /**
   * 创建笔记
   *
   * @param title 标题
   * @param content 内容
   * @param tags 标签
   * @returns 新创建的笔记节点
   */
  async createNote(
    title: string,
    content: string = '',
    tags: string[] = []
  ): Promise<Result<DstuNode, VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'createNote via DSTU:', path);
    const result = await dstu.create(path, {
      type: 'note',
      name: title,
      content,
      metadata: { tags },
    });
    if (!result.ok) {
      reportError(result.error, 'Create note');
    }
    return result;
  },

  /**
   * 更新笔记内容
   *
   * @param noteId 笔记 ID
   * @param content 新内容
   * @returns 更新后的笔记节点
   */
  async updateNoteContent(noteId: string, content: string): Promise<Result<DstuNode, VfsError>> {
    const path = `/${noteId}`;
    console.log(LOG_PREFIX, 'updateNoteContent via DSTU:', path);
    const result = await dstu.update(path, content, 'note');
    if (!result.ok) {
      reportError(result.error, 'Update note content');
    }
    return result;
  },

  /**
   * 更新笔记元数据
   *
   * @param noteId 笔记 ID
   * @param metadata 元数据（title, tags, isFavorite）
   */
  async updateNoteMetadata(
    noteId: string,
    metadata: { title?: string; tags?: string[]; isFavorite?: boolean }
  ): Promise<Result<DstuNode, VfsError>> {
    const path = `/${noteId}`;
    console.log(LOG_PREFIX, 'updateNoteMetadata via DSTU:', path);
    const setResult = await dstu.setMetadata(path, metadata);
    if (!setResult.ok) {
      reportError(setResult.error, 'Update note metadata');
      return err(setResult.error);
    }
    const getResult = await dstu.get(path);
    if (!getResult.ok) {
      reportError(getResult.error, 'Get updated note');
      return err(getResult.error);
    }
    if (!getResult.value) {
      const error = toVfsError(new Error(`Note not found: ${noteId}`), i18next.t('dstu:adapters.notes.noteNotFound'));
      reportError(error, 'Get updated note');
      return err(error);
    }
    return ok(getResult.value);
  },

  /**
   * 删除笔记
   *
   * @param noteId 笔记 ID
   */
  async deleteNote(noteId: string): Promise<Result<void, VfsError>> {
    const path = `/${noteId}`;
    console.log(LOG_PREFIX, 'deleteNote via DSTU:', path);
    const result = await dstu.delete(path);
    if (!result.ok) {
      reportError(result.error, 'Delete note');
    }
    return result;
  },

  /**
   * 搜索笔记
   *
   * @param query 搜索关键词
   * @param limit 结果数量限制
   * @returns 匹配的笔记节点
   */
  async searchNotes(query: string, limit: number = 50): Promise<Result<DstuNode[], VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'searchNotes via DSTU:', path, query, 'typeFilter: note');
    const result = await dstu.list(path, { search: query, limit, typeFilter: 'note' });
    if (!result.ok) {
      reportError(result.error, 'Search notes');
    }
    return result;
  },

  /**
   * 构建 DSTU 路径
   */
  buildPath: (folderPath: string | null, resourceId: string) => pathUtils.build(folderPath, resourceId),

  /**
   * 解析 DSTU 路径
   */
  parsePath: pathUtils.parse,
};

// ============================================================================
// React Hook
// ============================================================================

import { useState, useEffect, useCallback } from 'react';

export interface UseNotesDstuOptions {
  /** 是否自动加载 */
  autoLoad?: boolean;
  /** 排序字段 */
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc';
  /** 搜索关键词 */
  search?: string;
}

export interface UseNotesDstuReturn {
  /** 笔记节点列表 */
  notes: DstuNode[];
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 刷新列表 */
  refresh: () => Promise<void>;
  /** 创建笔记 */
  create: (title: string, content?: string, tags?: string[]) => Promise<DstuNode>;
  /** 删除笔记 */
  remove: (noteId: string) => Promise<void>;
}

/**
 * 笔记 DSTU Hook
 *
 * 提供笔记列表的 CRUD 操作
 */
export function useNotesDstu(
  options: UseNotesDstuOptions = {}
): UseNotesDstuReturn {
  const { autoLoad = true, sortBy, sortOrder, search } = options;

  const [notes, setNotes] = useState<DstuNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await notesDstuAdapter.listNotes({
      sortBy,
      sortOrder,
      search,
    });

    setLoading(false);

    if (result.ok) {
      setNotes(result.value);
    } else {
      setError(result.error.toUserMessage());
    }
  }, [sortBy, sortOrder, search]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const create = useCallback(
    async (title: string, content: string = '', tags: string[] = []): Promise<DstuNode> => {
      const result = await notesDstuAdapter.createNote(title, content, tags);
      if (result.ok) {
        await load();
        return result.value;
      }
      throw result.error;
    },
    [load]
  );

  const remove = useCallback(
    async (noteId: string): Promise<void> => {
      const result = await notesDstuAdapter.deleteNote(noteId);
      if (result.ok) {
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
      }
    },
    []
  );

  useEffect(() => {
    if (autoLoad) {
      load();
    }
  }, [autoLoad, load]);

  return {
    notes,
    loading,
    error,
    refresh,
    create,
    remove,
  };
}
