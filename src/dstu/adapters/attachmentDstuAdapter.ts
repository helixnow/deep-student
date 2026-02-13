/**
 * 附件模块 DSTU 适配器
 *
 * 统一处理 image 和 file 类型的附件资源
 *
 * 提供附件模块从旧 API 迁移到 DSTU API 的适配层。
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 10
 * @see P0-008: 创建Image/File类型适配器
 */

import i18next from 'i18next';
import { dstu } from '../api';
import { pathUtils } from '../utils/pathUtils';
import type { DstuNode, DstuNodeType, DstuListOptions } from '../types';
import { Result, VfsError, ok, err, reportError, toVfsError } from '@/shared/result';

// ============================================================================
// 配置
// ============================================================================

const LOG_PREFIX = '[AttachmentDSTU]';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 附件类型
 * - image: 图片附件
 * - file: 文件附件
 */
export type AttachmentType = 'image' | 'file';

/**
 * 附件元数据
 */
export interface AttachmentMetadata {
  /** 文件 MIME 类型 */
  mimeType?: string;
  /** 文件大小（字节） */
  fileSize?: number;
  /** 图片宽度（仅图片类型） */
  width?: number;
  /** 图片高度（仅图片类型） */
  height?: number;
  /** 缩略图 URL */
  thumbnailUrl?: string;
  /** 原始文件路径 */
  originalPath?: string;
  /** 是否收藏 */
  isFavorite?: boolean;
  /** 标签 */
  tags?: string[];
}

/**
 * 附件条目
 * 与旧 API 兼容的附件数据结构
 */
export interface AttachmentItem {
  /** 附件 ID */
  id: string;
  /** 附件名称 */
  name: string;
  /** DSTU 路径 */
  path: string;
  /** 附件类型 */
  attachment_type: AttachmentType;
  /** 文件 MIME 类型 */
  mime_type?: string;
  /** 文件大小（字节） */
  file_size?: number;
  /** 图片宽度（仅图片类型） */
  width?: number;
  /** 图片高度（仅图片类型） */
  height?: number;
  /** 缩略图 URL */
  thumbnail_url?: string;
  /** 创建时间（ISO 格式） */
  created_at: string;
  /** 更新时间（ISO 格式） */
  updated_at: string;
  /** 是否收藏 */
  is_favorite?: boolean;
  /** 标签 */
  tags?: string[];
}

// ============================================================================
// 类型转换
// ============================================================================

/**
 * 将 DstuNode 转换为 AttachmentItem
 *
 * 保持与现有代码的兼容性
 */
export function dstuNodeToAttachment(node: DstuNode): AttachmentItem {
  const metadata = node.metadata as AttachmentMetadata | undefined;

  // 确定附件类型
  const attachmentType: AttachmentType = node.type === 'image' ? 'image' : 'file';

  // 验证时间戳并转换为 ISO 字符串
  const createdAt = Number.isFinite(node.createdAt) && node.createdAt > 0
    ? new Date(node.createdAt).toISOString()
    : new Date().toISOString();

  const updatedAt = Number.isFinite(node.updatedAt) && node.updatedAt > 0
    ? new Date(node.updatedAt).toISOString()
    : new Date().toISOString();

  return {
    id: node.id,
    name: node.name,
    path: node.path,
    attachment_type: attachmentType,
    mime_type: metadata?.mimeType,
    // 使用 !== undefined 而不是 || 因为 0 是合法值
    file_size: node.size !== undefined ? node.size : metadata?.fileSize,
    width: metadata?.width,
    height: metadata?.height,
    thumbnail_url: metadata?.thumbnailUrl,
    created_at: createdAt,
    updated_at: updatedAt,
    is_favorite: metadata?.isFavorite || false,
    tags: metadata?.tags || [],
  };
}

/**
 * 将 AttachmentItem 转换为 DstuNode
 */
export function attachmentToDstuNode(attachment: AttachmentItem): DstuNode {
  // 根据 attachment_type 确定 DstuNodeType
  const nodeType: DstuNodeType = attachment.attachment_type === 'image' ? 'image' : 'file';

  return {
    id: attachment.id,
    sourceId: attachment.id,
    path: attachment.path || `/${attachment.id}`,
    name: attachment.name,
    type: nodeType,
    size: attachment.file_size,
    createdAt: new Date(attachment.created_at).getTime(),
    updatedAt: new Date(attachment.updated_at).getTime(),
    previewType: attachment.attachment_type === 'image' ? 'image' : 'none',
    metadata: {
      mimeType: attachment.mime_type,
      fileSize: attachment.file_size,
      width: attachment.width,
      height: attachment.height,
      thumbnailUrl: attachment.thumbnail_url,
      isFavorite: attachment.is_favorite,
      tags: attachment.tags,
    },
  };
}

// ============================================================================
// 适配器实现
// ============================================================================

/**
 * 附件 DSTU 适配器
 *
 * 提供 DSTU 语义的附件操作接口
 */
export const attachmentDstuAdapter = {
  /**
   * 列出附件
   *
   * @param attachmentType 附件类型筛选（可选）
   * @param options 列表选项
   * @returns 附件节点数组
   *
   * 注意：当指定 attachmentType 时，后端已处理分页，直接返回结果。
   * 当未指定类型时（需要合并 image 和 file），会在客户端应用排序和分页。
   */
  async list(
    attachmentType?: AttachmentType,
    options?: DstuListOptions
  ): Promise<Result<DstuNode[], VfsError>> {
    const path = '/';

    // 根据 attachmentType 确定 typeFilter
    const typeFilter: DstuNodeType | undefined = attachmentType
      ? (attachmentType === 'image' ? 'image' : 'file')
      : undefined;

    const logMsg = typeFilter
      ? `list via DSTU: ${path}, typeFilter: ${typeFilter}`
      : `list via DSTU: ${path} (all attachments)`;

    console.log(LOG_PREFIX, logMsg);

    // 如果指定了类型，直接返回后端结果（后端已处理分页）
    if (typeFilter) {
      const result = await dstu.list(path, { ...options, typeFilter });
      if (!result.ok) {
        reportError(result.error, 'List attachments');
      }
      return result;
    }

    // 否则，需要分别获取 image 和 file 类型并合并
    const [imageResult, fileResult] = await Promise.all([
      dstu.list(path, { ...options, typeFilter: 'image' }),
      dstu.list(path, { ...options, typeFilter: 'file' }),
    ]);

    // 处理错误情况
    if (!imageResult.ok && !fileResult.ok) {
      // 两者都失败，返回第一个错误
      reportError(imageResult.error, 'List image attachments');
      return imageResult;
    }

    if (!imageResult.ok) {
      reportError(imageResult.error, 'List image attachments');
      // 只返回文件列表
      return fileResult;
    }

    if (!fileResult.ok) {
      reportError(fileResult.error, 'List file attachments');
      // 只返回图片列表
      return imageResult;
    }

    // 合并结果
    const mergedNodes = [...imageResult.value, ...fileResult.value];

    // 应用排序（如果指定）
    if (options?.sortBy) {
      const sortBy = options.sortBy;
      const sortOrder = options.sortOrder || 'asc';
      const multiplier = sortOrder === 'asc' ? 1 : -1;

      mergedNodes.sort((a, b) => {
        let aVal: string | number;
        let bVal: string | number;

        if (sortBy === 'name') {
          aVal = a.name;
          bVal = b.name;
        } else if (sortBy === 'createdAt') {
          aVal = a.createdAt;
          bVal = b.createdAt;
        } else if (sortBy === 'updatedAt') {
          aVal = a.updatedAt;
          bVal = b.updatedAt;
        } else {
          return 0;
        }

        if (aVal < bVal) return -1 * multiplier;
        if (aVal > bVal) return 1 * multiplier;
        return 0;
      });
    }

    // 应用分页（如果指定）
    let finalNodes = mergedNodes;
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const offset = options.offset || 0;
      const limit = options.limit;
      finalNodes = limit !== undefined
        ? mergedNodes.slice(offset, offset + limit)
        : mergedNodes.slice(offset);
    }

    return ok(finalNodes);
  },

  /**
   * 获取附件详情
   *
   * @param attachmentId 附件 ID
   * @returns 附件节点
   */
  async get(attachmentId: string): Promise<Result<DstuNode | null, VfsError>> {
    const path = `/${attachmentId}`;
    console.log(LOG_PREFIX, 'get via DSTU:', path);
    const result = await dstu.get(path);
    if (!result.ok) {
      reportError(result.error, 'Get attachment detail');
    }
    return result;
  },

  /**
   * 删除附件
   *
   * @param attachmentId 附件 ID
   */
  async delete(attachmentId: string): Promise<Result<void, VfsError>> {
    const path = `/${attachmentId}`;
    console.log(LOG_PREFIX, 'delete via DSTU:', path);
    const result = await dstu.delete(path);
    if (!result.ok) {
      reportError(result.error, 'Delete attachment');
    }
    return result;
  },

  /**
   * 创建附件
   *
   * @param file 文件对象
   * @param attachmentType 附件类型（自动检测或手动指定）
   * @param metadata 扩展元数据
   * @returns 新创建的附件节点
   */
  async create(
    file: File | Blob,
    attachmentType?: AttachmentType,
    metadata?: Record<string, unknown>
  ): Promise<Result<DstuNode, VfsError>> {
    const path = '/';

    // 确定附件类型
    let type: DstuNodeType;
    if (attachmentType) {
      type = attachmentType === 'image' ? 'image' : 'file';
    } else {
      // 自动检测：根据 MIME 类型判断
      const mimeType = file instanceof File ? file.type : 'application/octet-stream';
      type = mimeType.startsWith('image/') ? 'image' : 'file';
    }

    const name = file instanceof File ? file.name : 'unnamed';

    console.log(LOG_PREFIX, 'create via DSTU:', path, { type, name });

    const result = await dstu.create(path, {
      type,
      name,
      file,
      metadata: {
        mimeType: file instanceof File ? file.type : 'application/octet-stream',
        fileSize: file.size,
        ...metadata,
      },
    });

    if (!result.ok) {
      reportError(result.error, 'Create attachment');
    }
    return result;
  },

  /**
   * 更新附件元数据
   *
   * @param attachmentId 附件 ID
   * @param metadata 元数据
   */
  async updateMetadata(
    attachmentId: string,
    metadata: { name?: string; isFavorite?: boolean; tags?: string[] }
  ): Promise<Result<DstuNode, VfsError>> {
    const path = `/${attachmentId}`;
    console.log(LOG_PREFIX, 'updateMetadata via DSTU:', path);
    const setResult = await dstu.setMetadata(path, metadata);
    if (!setResult.ok) {
      reportError(setResult.error, 'Update attachment metadata');
      return err(setResult.error);
    }
    const getResult = await dstu.get(path);
    if (!getResult.ok) {
      reportError(getResult.error, 'Get updated attachment');
      return err(getResult.error);
    }
    if (!getResult.value) {
      const error = toVfsError(new Error(`Attachment not found: ${attachmentId}`), i18next.t('dstu:adapters.attachment.attachmentNotFound'));
      reportError(error, 'Get updated attachment');
      return err(error);
    }
    return ok(getResult.value);
  },

  /**
   * 设置收藏状态
   *
   * @param attachmentId 附件 ID
   * @param isFavorite 是否收藏
   */
  async setFavorite(attachmentId: string, isFavorite: boolean): Promise<Result<void, VfsError>> {
    const path = `/${attachmentId}`;
    console.log(LOG_PREFIX, 'setFavorite via DSTU:', path, isFavorite);
    const result = await dstu.setFavorite(path, isFavorite);
    if (!result.ok) {
      reportError(result.error, 'Set attachment favorite');
    }
    return result;
  },

  /**
   * 搜索附件
   *
   * @param query 搜索关键词
   * @param attachmentType 附件类型筛选（可选）
   * @param limit 结果数量限制
   * @returns 匹配的附件节点
   */
  async search(
    query: string,
    attachmentType?: AttachmentType,
    limit: number = 50
  ): Promise<Result<DstuNode[], VfsError>> {
    const path = '/';

    // 根据 attachmentType 确定 typeFilter
    const typeFilter: DstuNodeType | undefined = attachmentType
      ? (attachmentType === 'image' ? 'image' : 'file')
      : undefined;

    const logMsg = typeFilter
      ? `search via DSTU: ${path}, query="${query}", typeFilter: ${typeFilter}`
      : `search via DSTU: ${path}, query="${query}" (all attachments)`;

    console.log(LOG_PREFIX, logMsg);

    // 如果指定了类型，直接搜索
    if (typeFilter) {
      const result = await dstu.list(path, { search: query, limit, typeFilter });
      if (!result.ok) {
        reportError(result.error, 'Search attachments');
      }
      return result;
    }

    // 否则，需要分别搜索 image 和 file 类型并合并
    const [imageResult, fileResult] = await Promise.all([
      dstu.list(path, { search: query, limit, typeFilter: 'image' }),
      dstu.list(path, { search: query, limit, typeFilter: 'file' }),
    ]);

    // 处理错误情况
    if (!imageResult.ok && !fileResult.ok) {
      reportError(imageResult.error, 'Search image attachments');
      return imageResult;
    }

    if (!imageResult.ok) {
      reportError(imageResult.error, 'Search image attachments');
      return fileResult;
    }

    if (!fileResult.ok) {
      reportError(fileResult.error, 'Search file attachments');
      return imageResult;
    }

    // 合并结果并限制数量
    const mergedNodes = [...imageResult.value, ...fileResult.value];
    const limitedNodes = mergedNodes.slice(0, limit);

    return ok(limitedNodes);
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

import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseAttachmentsDstuOptions {
  /** 附件类型筛选（image/file/undefined表示全部） */
  attachmentType?: AttachmentType;
  /** 是否自动加载 */
  autoLoad?: boolean;
  /** 排序字段 */
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc';
  /** 搜索关键词 */
  search?: string;
  /** 是否只显示收藏 */
  favoritesOnly?: boolean;
  /** 分页：每页数量 */
  limit?: number;
  /** 分页：偏移量 */
  offset?: number;
}

export interface UseAttachmentsDstuReturn {
  /** 附件节点列表 */
  attachments: DstuNode[];
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 刷新列表 */
  refresh: () => Promise<void>;
  /** 创建附件 */
  create: (file: File | Blob, attachmentType?: AttachmentType, metadata?: Record<string, unknown>) => Promise<DstuNode>;
  /** 删除附件 */
  remove: (attachmentId: string) => Promise<void>;
  /** 加载更多（分页） */
  loadMore: () => Promise<void>;
  /** 是否有更多数据 */
  hasMore: boolean;
}

/**
 * 附件 DSTU Hook
 *
 * 提供附件列表的 CRUD 操作，支持类型筛选和分页加载
 */
export function useAttachmentsDstu(
  options: UseAttachmentsDstuOptions = {}
): UseAttachmentsDstuReturn {
  const {
    attachmentType,
    autoLoad = true,
    sortBy,
    sortOrder,
    search,
    favoritesOnly,
    limit = 20,
    offset: initialOffset = 0,
  } = options;

  const [attachments, setAttachments] = useState<DstuNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentOffset, setCurrentOffset] = useState(initialOffset);
  const [hasMore, setHasMore] = useState(true);

  // ★ HIGH-A001 修复：使用 ref 存储 offset 避免无限循环
  const offsetRef = useRef(initialOffset);
  // ★ HIGH-A004 修复：使用 ref 进行原子的并发防护检查
  const loadingRef = useRef(false);
  // ★ HIGH-A001 修复：追踪是否已经初始加载，避免重复触发
  const hasLoadedRef = useRef(false);

  const load = useCallback(
    async (append = false) => {
      // ★ HIGH-A004 修复：使用 ref 进行原子检查，避免竞态条件
      if (loadingRef.current) {
        console.warn(LOG_PREFIX, 'Load already in progress, skipping');
        return;
      }

      loadingRef.current = true;
      setLoading(true);
      setError(null);

      const listOptions: DstuListOptions = {
        sortBy,
        sortOrder,
        search,
        isFavorite: favoritesOnly,
        limit,
        offset: append ? offsetRef.current : initialOffset,
      };

      const result = await attachmentDstuAdapter.list(attachmentType, listOptions);

      loadingRef.current = false;
      setLoading(false);

      if (result.ok) {
        const newAttachments = result.value;

        if (append) {
          setAttachments((prev) => [...prev, ...newAttachments]);
        } else {
          setAttachments(newAttachments);
        }

        // 判断是否还有更多数据
        setHasMore(newAttachments.length === limit);

        // 更新 offset（使用 ref 避免触发依赖）
        if (append) {
          offsetRef.current += newAttachments.length;
        } else {
          offsetRef.current = initialOffset + newAttachments.length;
        }
        // 同步更新显示状态
        setCurrentOffset(offsetRef.current);
      } else {
        setError(result.error.toUserMessage());
        setHasMore(false);
      }
    },
    [attachmentType, sortBy, sortOrder, search, favoritesOnly, limit, initialOffset]
  );

  const refresh = useCallback(async () => {
    offsetRef.current = initialOffset;
    setCurrentOffset(initialOffset);
    setHasMore(true);
    await load(false);
  }, [load, initialOffset]);

  const loadMore = useCallback(async () => {
    if (!loading && hasMore) {
      await load(true);
    }
  }, [load, loading, hasMore]);

  const create = useCallback(
    async (
      file: File | Blob,
      attachmentType?: AttachmentType,
      metadata?: Record<string, unknown>
    ): Promise<DstuNode> => {
      const result = await attachmentDstuAdapter.create(file, attachmentType, metadata);
      if (result.ok) {
        await refresh();
        return result.value;
      }
      throw result.error;
    },
    [refresh]
  );

  const remove = useCallback(
    async (attachmentId: string): Promise<void> => {
      const result = await attachmentDstuAdapter.delete(attachmentId);
      if (result.ok) {
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
      } else {
        throw result.error;
      }
    },
    []
  );

  // ★ HIGH-A001 修复：避免 useEffect 无限循环
  useEffect(() => {
    if (autoLoad && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      load(false);
    }
  }, [autoLoad, load]);

  return {
    attachments,
    loading,
    error,
    refresh,
    create,
    remove,
    loadMore,
    hasMore,
  };
}
