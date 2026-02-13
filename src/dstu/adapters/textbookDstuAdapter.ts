/**
 * 教材模块 DSTU 适配器
 *
 * 提供教材模块从旧 API 迁移到 DSTU API 的适配层。
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 10
 */

import { dstu } from '../api';
import { pathUtils } from '../utils/pathUtils';
import type { DstuNode, DstuListOptions, DstuPreviewType } from '../types';
import { Result, VfsError, ok, err, reportError, toVfsError } from '@/shared/result';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// 配置
// ============================================================================

const LOG_PREFIX = '[TextbookDSTU]';

// ============================================================================
// 类型定义（与旧 API 兼容）
// ============================================================================

/**
 * 阅读进度类型
 */
export interface TextbookReadingProgress {
  /** 当前页码 (1-based) */
  page: number;
  /** 最后阅读时间 (Unix 毫秒) */
  lastReadAt?: number;
}

export interface TextbookItem {
  id: string;
  name: string;
  path: string;
  page_count: number;
  created_at: string;
  updated_at: string;
  file_size?: number;
  cover_image?: string;
  /** PDF 文件的实际路径 */
  file_path?: string;
  /** 阅读进度 */
  reading_progress?: TextbookReadingProgress;
}

// ============================================================================
// 类型转换
// ============================================================================

/**
 * 将 DstuNode 转换为 TextbookItem
 */
export function dstuNodeToTextbookItem(node: DstuNode): TextbookItem {
  const readingProgress = node.metadata?.readingProgress as TextbookReadingProgress | undefined;
  
  return {
    id: node.id,
    name: node.name,
    path: node.path,
    page_count: (node.metadata?.pageCount as number) || 0,
    created_at: new Date(node.createdAt).toISOString(),
    updated_at: new Date(node.updatedAt).toISOString(),
    file_size: node.size,
    cover_image: node.metadata?.coverImage as string | undefined,
    file_path: node.metadata?.filePath as string | undefined,
    reading_progress: readingProgress,
  };
}

/**
 * 将 TextbookItem 转换为 DstuNode
 */
export function textbookItemToDstuNode(item: TextbookItem): DstuNode {
  return {
    id: item.id,
    sourceId: item.id,
    path: `/${item.id}`,
    name: item.name,
    type: 'textbook',
    size: item.file_size || 0,
    createdAt: new Date(item.created_at).getTime(),
    updatedAt: new Date(item.updated_at).getTime(),
    // resourceId 和 resourceHash 从后端获取，前端适配器暂不填
    previewType: 'pdf',
    metadata: {
      pageCount: item.page_count,
      coverImage: item.cover_image,
      filePath: item.file_path,
      readingProgress: item.reading_progress,
    },
  };
}

// ============================================================================
// 适配器实现
// ============================================================================

/**
 * 教材 DSTU 适配器
 */
export const textbookDstuAdapter = {
  /**
   * 列出教材
   */
  async listTextbooks(options?: DstuListOptions): Promise<Result<DstuNode[], VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'listTextbooks via DSTU:', path, 'typeFilter: textbook');
    const result = await dstu.list(path, { ...options, typeFilter: 'textbook' });
    if (!result.ok) {
      reportError(result.error, '列出教材');
    }
    return result;
  },

  /**
   * 获取教材详情
   */
  async getTextbook(textbookId: string): Promise<Result<DstuNode | null, VfsError>> {
    const path = `/${textbookId}`;
    console.log(LOG_PREFIX, 'getTextbook via DSTU:', path);
    const result = await dstu.get(path);
    if (!result.ok) {
      reportError(result.error, '获取教材详情');
    }
    return result;
  },

  /**
   * 删除教材
   */
  async deleteTextbook(textbookId: string): Promise<Result<void, VfsError>> {
    const path = `/${textbookId}`;
    console.log(LOG_PREFIX, 'deleteTextbook via DSTU:', path);
    const result = await dstu.delete(path);
    if (!result.ok) {
      reportError(result.error, '删除教材');
    }
    return result;
  },

  /**
   * 设置收藏状态
   */
  async setFavorite(textbookId: string, isFavorite: boolean): Promise<Result<void, VfsError>> {
    const path = `/${textbookId}`;
    console.log(LOG_PREFIX, 'setFavorite via DSTU:', path, isFavorite);
    const result = await dstu.setFavorite(path, isFavorite);
    if (!result.ok) {
      reportError(result.error, '设置收藏状态');
    }
    return result;
  },

  /**
   * 添加教材（从本地文件路径）
   *
   * 注意：使用后端的 textbooks_add 命令，该命令会：
   * 1. 计算文件 SHA256
   * 2. 复制文件到 textbooks 目录
   * 3. 创建 VFS 教材记录
   * 4. 异步触发多模态索引（图片向量化）
   */
  async addTextbooks(filePaths: string[], folderId?: string | null): Promise<Result<DstuNode[], VfsError>> {
    console.log(LOG_PREFIX, 'addTextbooks via textbooks_add:', filePaths.length, 'files', 'folderId:', folderId);
    
    if (filePaths.length === 0) {
      return ok([]);
    }

    try {
      // 调用后端 textbooks_add 命令（传递 folder_id 以便放入正确文件夹）
      const rawResults = await invoke<any[]>('textbooks_add', { sources: filePaths, folderId: folderId || null });
      const list = Array.isArray(rawResults) ? rawResults : [];
      
      // 转换为 DstuNode 格式
      const nodes: DstuNode[] = list.map((r: any) => {
        const fileName = r.file_name || r.name || 'unknown.pdf';
        const ext = fileName.split('.').pop()?.toLowerCase() || 'pdf';
        
        // 根据文件扩展名确定预览类型
        const getPreviewType = (extension: string): DstuPreviewType => {
          switch (extension) {
            case 'pdf': return 'pdf';
            case 'docx':
            case 'doc': return 'docx';
            case 'xlsx':
            case 'xls':
            case 'ods': return 'xlsx';
            case 'pptx':
            case 'ppt': return 'pptx'; // PPTX/PPT 演示文稿预览
            case 'txt':
            case 'md': return 'text';
            default: return 'none';
          }
        };
        
        return {
          id: r.id,
          sourceId: r.id,
          path: `/${r.id}`,
          name: fileName,
          type: 'textbook' as const,
          size: typeof r.size === 'number' ? r.size : 0,
          createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
          updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now(),
          previewType: getPreviewType(ext),
          metadata: {
            pageCount: r.page_count || 0,
            filePath: r.file_path,
          },
        };
      });

      console.log(LOG_PREFIX, 'addTextbooks success:', nodes.length, 'textbooks created');
      

      
      return ok(nodes);
    } catch (error: unknown) {
      const vfsError = toVfsError(error, '添加教材');
      reportError(vfsError, '添加教材');
      return err(vfsError);
    }
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

export interface UseTextbooksDstuOptions {
  autoLoad?: boolean;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface UseTextbooksDstuReturn {
  textbooks: DstuNode[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  remove: (textbookId: string) => Promise<void>;
}

/**
 * 教材 DSTU Hook
 */
export function useTextbooksDstu(
  options: UseTextbooksDstuOptions = {}
): UseTextbooksDstuReturn {
  const { autoLoad = true, sortBy, sortOrder } = options;

  const [textbooks, setTextbooks] = useState<DstuNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await textbookDstuAdapter.listTextbooks({
      sortBy,
      sortOrder,
    });

    setLoading(false);

    if (result.ok) {
      setTextbooks(result.value);
    } else {
      setError(result.error.toUserMessage());
    }
  }, [sortBy, sortOrder]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const remove = useCallback(
    async (textbookId: string): Promise<void> => {
      const result = await textbookDstuAdapter.deleteTextbook(textbookId);
      if (result.ok) {
        setTextbooks((prev) => prev.filter((t) => t.id !== textbookId));
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
    textbooks,
    loading,
    error,
    refresh,
    remove,
  };
}
