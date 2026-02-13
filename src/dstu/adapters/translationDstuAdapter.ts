/**
 * 翻译模块 DSTU 适配器
 *
 * 提供翻译模块从旧 API 迁移到 DSTU API 的适配层。
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 10
 */

import { dstu } from '../api';
import { pathUtils } from '../utils/pathUtils';
import type { DstuNode, DstuListOptions } from '../types';
import type { TranslationHistoryItem } from '@/utils/tauriApi';
import { Result, VfsError, ok, err, reportError, toVfsError } from '@/shared/result';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// 翻译会话类型（DSTU 模式）
// ============================================================================

/**
 * 翻译会话数据结构
 *
 * 用于 Learning Hub 中的翻译资源管理
 */
export interface TranslationSession {
  /** 会话 ID */
  id: string;
  /** 源文本 */
  sourceText: string;
  /** 译文 */
  translatedText: string;
  /** 源语言代码 */
  srcLang: string;
  /** 目标语言代码 */
  tgtLang: string;
  /** 正式度：formal（正式）、casual（随意）、auto（自动） */
  formality: 'formal' | 'casual' | 'auto';
  /** 自定义提示词 */
  customPrompt?: string;
  /** 翻译质量评分 (1-5) */
  quality?: number;
  /** 是否收藏 */
  isFavorite?: boolean;
  /** 创建时间（Unix 毫秒） */
  createdAt: number;
  /** 更新时间（Unix 毫秒） */
  updatedAt: number;
}

/**
 * 生成唯一翻译会话 ID
 */
export function generateTranslationId(): string {
  return `tr_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

// ============================================================================
// 配置
// ============================================================================

const LOG_PREFIX = '[TranslationDSTU]';

// ============================================================================
// 类型转换
// ============================================================================

/**
 * 将 DstuNode 转换为 TranslationSession
 */
export function dstuNodeToTranslationSession(node: DstuNode): TranslationSession {
  const meta = node.metadata || {};
  return {
    id: node.id,
    sourceText: (meta.sourceText as string) || '',
    translatedText: (meta.translatedText as string) || '',
    srcLang: (meta.srcLang as string) || 'auto',
    tgtLang: (meta.tgtLang as string) || 'zh',
    formality: (meta.formality as 'formal' | 'casual' | 'auto') || 'auto',
    customPrompt: meta.customPrompt as string | undefined,
    quality: meta.qualityRating as number | undefined,
    isFavorite: Boolean(meta.isFavorite),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/**
 * 将 DstuNode 转换为 TranslationHistoryItem
 */
export function dstuNodeToTranslationItem(node: DstuNode): TranslationHistoryItem {
  const meta = node.metadata || {};
  return {
    id: node.id,
    source_text: (meta.sourceText as string) || '',
    translated_text: (meta.translatedText as string) || '',
    src_lang: (meta.srcLang as string) || 'auto',
    tgt_lang: (meta.tgtLang as string) || 'zh',
    prompt_used: meta.promptUsed as string | null,
    created_at: new Date(node.createdAt).toISOString(),
    is_favorite: Boolean(meta.isFavorite),
    quality_rating: meta.qualityRating as number | null,
  };
}

/**
 * 将 TranslationHistoryItem 转换为 DstuNode
 */
export function translationItemToDstuNode(item: TranslationHistoryItem): DstuNode {
  return {
    id: item.id,
    sourceId: item.id,
    path: `/${item.id}`,
    name: item.source_text.substring(0, 50) + (item.source_text.length > 50 ? '...' : ''),
    type: 'translation',
    size: item.source_text.length + item.translated_text.length,
    createdAt: new Date(item.created_at).getTime(),
    updatedAt: new Date(item.created_at).getTime(),
    // resourceId 和 resourceHash 从后端获取，前端适配器暂不填
    previewType: 'markdown',
    metadata: {
      sourceText: item.source_text,
      translatedText: item.translated_text,
      srcLang: item.src_lang,
      tgtLang: item.tgt_lang,
      promptUsed: item.prompt_used,
      isFavorite: item.is_favorite,
      qualityRating: item.quality_rating,
    },
  };
}

// ============================================================================
// 适配器实现
// ============================================================================

/**
 * 翻译 DSTU 适配器
 */
export const translationDstuAdapter = {
  /**
   * 列出翻译历史
   */
  async listTranslations(options?: {
    offset?: number;
    limit?: number;
    search?: string;
  }): Promise<Result<{ items: DstuNode[]; total: number }, VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'listTranslations via DSTU:', path, 'typeFilter: translation');
    const result = await dstu.list(path, {
      offset: options?.offset,
      limit: options?.limit,
      search: options?.search,
      typeFilter: 'translation',
    });
    if (!result.ok) {
      reportError(result.error, 'List translation history');
      return err(result.error);
    }
    return ok({
      items: result.value,
      total: result.value.length,
    });
  },

  /**
   * 获取翻译详情
   */
  async getTranslation(translationId: string): Promise<Result<DstuNode | null, VfsError>> {
    const path = `/${translationId}`;
    console.log(LOG_PREFIX, 'getTranslation via DSTU:', path);
    const result = await dstu.get(path);
    if (!result.ok) {
      reportError(result.error, 'Get translation detail');
    }
    return result;
  },

  /**
   * 删除翻译
   */
  async deleteTranslation(translationId: string): Promise<Result<void, VfsError>> {
    const path = `/${translationId}`;
    console.log(LOG_PREFIX, 'deleteTranslation via DSTU:', path);
    const result = await dstu.delete(path);
    if (!result.ok) {
      reportError(result.error, 'Delete translation');
    }
    return result;
  },

  /**
   * 切换收藏状态
   *
   * ★ MEDIUM-006 优化：支持传入当前状态，避免额外的 get 请求
   */
  async toggleFavorite(translationId: string, currentFavorite?: boolean): Promise<Result<boolean, VfsError>> {
    const path = `/${translationId}`;
    console.log(LOG_PREFIX, 'toggleFavorite via DSTU:', path);
    console.log(LOG_PREFIX, 'toggleFavorite currentFavorite:', currentFavorite);

    let newFavorite: boolean;

    // 如果提供了当前状态，直接翻转；否则需要先获取
    if (currentFavorite !== undefined) {
      newFavorite = !currentFavorite;
    } else {
      // 先获取当前状态
      const getResult = await dstu.get(path);
      if (!getResult.ok) {
        reportError(getResult.error, 'Get translation');
        return err(getResult.error);
      }

      newFavorite = !getResult.value?.metadata?.isFavorite;
    }

    // 使用统一的 setFavorite API
    const setResult = await dstu.setFavorite(path, newFavorite);
    if (!setResult.ok) {
      reportError(setResult.error, 'Toggle favorite');
      return err(setResult.error);
    }

    return ok(newFavorite);
  },

  /**
   * 设置收藏状态（直接设置，不需要先获取）
   *
   * ★ MEDIUM-006 新增：提供直接设置收藏状态的方法
   */
  async setFavorite(translationId: string, isFavorite: boolean): Promise<Result<void, VfsError>> {
    const path = `/${translationId}`;
    console.log(LOG_PREFIX, 'setFavorite via DSTU:', path, 'isFavorite:', isFavorite);

    const result = await dstu.setFavorite(path, isFavorite);
    if (!result.ok) {
      reportError(result.error, 'Set favorite');
    }
    return result;
  },

  /**
   * 构建 DSTU 路径
   */
  buildPath: (id?: string) => id ? `/${id}` : '/',

  /**
   * 解析 DSTU 路径
   */
  parsePath: pathUtils.parse,

  /**
   * 创建翻译记录（DSTU 模式）
   */
  async createTranslation(session: TranslationSession): Promise<Result<DstuNode, VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'createTranslation via DSTU:', path);
    const result = await dstu.create(path, {
      type: 'translation',
      name: session.sourceText.substring(0, 50) + (session.sourceText.length > 50 ? '...' : ''),
      metadata: {
        sourceText: session.sourceText,
        translatedText: session.translatedText,
        srcLang: session.srcLang,
        tgtLang: session.tgtLang,
        formality: session.formality,
        customPrompt: session.customPrompt,
        qualityRating: session.quality,
        isFavorite: session.isFavorite || false,
      },
    });
    if (!result.ok) {
      reportError(result.error, 'Create translation record');
    }
    return result;
  },

  /**
   * 更新翻译记录（DSTU 模式）
   */
  async updateTranslation(session: TranslationSession): Promise<Result<void, VfsError>> {
    const path = `/${session.id}`;
    console.log(LOG_PREFIX, 'updateTranslation via DSTU:', path);
    const result = await dstu.setMetadata(path, {
      sourceText: session.sourceText,
      translatedText: session.translatedText,
      srcLang: session.srcLang,
      tgtLang: session.tgtLang,
      formality: session.formality,
      customPrompt: session.customPrompt,
      qualityRating: session.quality,
      isFavorite: session.isFavorite,
    });
    if (!result.ok) {
      reportError(result.error, 'Update translation record');
    }
    return result;
  },
};

// ============================================================================
// React Hook
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseTranslationsDstuOptions {
  autoLoad?: boolean;
  limit?: number;
  search?: string;
}

export interface UseTranslationsDstuReturn {
  translations: DstuNode[];
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
}

/**
 * 翻译 DSTU Hook
 */
export function useTranslationsDstu(
  options: UseTranslationsDstuOptions = {}
): UseTranslationsDstuReturn {
  const { autoLoad = true, limit = 20, search } = options;

  const [translations, setTranslations] = useState<DstuNode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // ★ HIGH-A006 修复：使用 ref 进行原子的并发防护检查
  const loadingRef = useRef(false);
  // ★ HIGH-A005 修复：使用 ref 存储 offset 避免 stale closure
  const offsetRef = useRef(0);

  const load = useCallback(async (reset = false) => {
    // ★ HIGH-A006 修复：使用 ref 进行原子检查，避免竞态条件
    if (loadingRef.current) {
      console.warn(LOG_PREFIX, 'Load already in progress, skipping');
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    const currentOffset = reset ? 0 : offsetRef.current;
    const result = await translationDstuAdapter.listTranslations({
      offset: currentOffset,
      limit,
      search,
    });

    loadingRef.current = false;
    setLoading(false);

    if (result.ok) {
      const data = result.value.items;

      if (reset) {
        setTranslations(data);
        // ★ MEDIUM-007 修复：添加边界保护
        const dataLength = Math.max(0, Math.floor(data?.length || 0));
        offsetRef.current = dataLength;
        setOffset(dataLength);
      } else {
        setTranslations((prev) => {
          // ★ MEDIUM-007 修复：检测重复数据
          const existingIds = new Set(prev.map(t => t.id));
          const newItems = data.filter(t => !existingIds.has(t.id));
          return [...prev, ...newItems];
        });
        // ★ MEDIUM-007 修复：添加边界检查
        const dataLength = Math.max(0, Math.floor(data?.length || 0));
        const newOffset = offsetRef.current + dataLength;
        // 边界检查
        if (newOffset < 0 || !Number.isFinite(newOffset)) {
          console.error(LOG_PREFIX, `Invalid offset: ${newOffset}, resetting to 0`);
          offsetRef.current = 0;
          setOffset(0);
        } else {
          offsetRef.current = newOffset;
          setOffset(newOffset);
        }
      }

      setTotal(result.value.total);
      setHasMore(data.length >= limit);
    } else {
      setError(result.error.toUserMessage());
    }
  }, [limit, search]);

  const refresh = useCallback(async () => {
    offsetRef.current = 0;
    setOffset(0);
    await load(true);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await load(false);
  }, [hasMore, loading, load]);

  const remove = useCallback(async (id: string): Promise<void> => {
    const result = await translationDstuAdapter.deleteTranslation(id);
    if (result.ok) {
      setTranslations((prev) => prev.filter((t) => t.id !== id));
      setTotal((prev) => prev - 1);
    }
  }, []);

  const toggleFav = useCallback(async (id: string): Promise<void> => {
    // ★ MEDIUM-006 优化：使用本地状态获取当前值，避免额外请求
    const currentTranslation = translations.find(t => t.id === id);
    const currentFavorite = currentTranslation?.metadata?.isFavorite as boolean | undefined;

    // 乐观更新 UI
    const newFavorite = !currentFavorite;
    setTranslations((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, metadata: { ...t.metadata, isFavorite: newFavorite } }
          : t
      )
    );

    // 后台执行实际请求
    const result = await translationDstuAdapter.toggleFavorite(id, currentFavorite);
    if (!result.ok) {
      // 请求失败，回滚更新
      setTranslations((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, metadata: { ...t.metadata, isFavorite: currentFavorite } }
            : t
        )
      );
    }
  }, [translations]);

  // ★ HIGH-A005 修复：正确添加所有必要的依赖，避免 stale closure
  useEffect(() => {
    if (autoLoad) {
      setTranslations([]);
      offsetRef.current = 0;
      setOffset(0);
      setHasMore(true);
      load(true);
    }
  }, [autoLoad, search, load]);

  return {
    translations,
    total,
    loading,
    error,
    hasMore,
    refresh,
    loadMore,
    remove,
    toggleFavorite: toggleFav,
  };
}
