/**
 * 多模态知识库检索 Hook
 *
 * 提供多模态知识库的检索功能，支持：
 * - 文本检索
 * - 图片检索
 * - 混合检索
 * - 配置状态检查
 *
 * 设计文档: docs/multimodal-user-memory-design.md
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import multimodalRagService, {
  type MultimodalRetrievalResult,
  type RetrievalConfig,
  MULTIMODAL_INDEX_ENABLED,
} from '@/services/multimodalRagService';
import { t } from '@/utils/i18n';

// ============================================================================
// 类型定义
// ============================================================================

export interface UseMultimodalSearchOptions {
  /** 默认检索数量 */
  defaultTopK?: number;
  /** 自动检查配置状态 */
  autoCheckConfig?: boolean;
}

export interface MultimodalSearchState {
  /** 是否正在加载 */
  loading: boolean;
  /** 检索结果 */
  results: MultimodalRetrievalResult[];
  /** 错误信息 */
  error: string | null;
  /** 多模态知识库是否已配置 */
  isConfigured: boolean | null;
  /** 最近一次查询 */
  lastQuery: string | null;
}

export interface MultimodalSearchActions {
  /** 文本检索 */
  searchByText: (query: string, config?: RetrievalConfig) => Promise<MultimodalRetrievalResult[]>;
  /** 图片检索 */
  searchByImage: (imageBase64: string, config?: RetrievalConfig) => Promise<MultimodalRetrievalResult[]>;
  /** 混合检索（文本+图片） */
  searchMixed: (
    query: string,
    imageBase64: string,
    config?: RetrievalConfig
  ) => Promise<MultimodalRetrievalResult[]>;
  /** 检查配置状态 */
  checkConfig: () => Promise<boolean>;
  /** 清空结果 */
  clearResults: () => void;
  /** 取消当前请求 */
  cancel: () => void;
}

export type UseMultimodalSearchReturn = MultimodalSearchState & MultimodalSearchActions;

// ============================================================================
// Hook 实现
// ============================================================================

export function useMultimodalSearch(
  options: UseMultimodalSearchOptions = {}
): UseMultimodalSearchReturn {
  const { defaultTopK = 10, autoCheckConfig = true } = options;

  // 状态
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<MultimodalRetrievalResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
  const [lastQuery, setLastQuery] = useState<string | null>(null);

  // 取消标记
  const cancelRef = useRef(false);
  const requestIdRef = useRef(0);

  // 检查配置状态
  // ★ 多模态索引已禁用时直接返回 false，避免调用已废弃的 isConfigured()
  const checkConfig = useCallback(async (): Promise<boolean> => {
    if (!MULTIMODAL_INDEX_ENABLED) {
      setIsConfigured(false);
      return false;
    }
    try {
      const configured = await multimodalRagService.isConfigured();
      setIsConfigured(configured);
      return configured;
    } catch (err: unknown) {
      console.error('检查多模态配置失败:', err);
      setIsConfigured(false);
      return false;
    }
  }, []);

  // 初始化时检查配置（使用 useEffect 避免渲染期间副作用）
  useEffect(() => {
    if (autoCheckConfig && isConfigured === null) {
      checkConfig();
    }
  }, [autoCheckConfig, isConfigured, checkConfig]);

  // 文本检索
  const searchByText = useCallback(
    async (query: string, config?: RetrievalConfig): Promise<MultimodalRetrievalResult[]> => {
      const requestId = ++requestIdRef.current;
      cancelRef.current = false;

      setLoading(true);
      setError(null);
      setLastQuery(query);

      try {
        const retrievalResults = await multimodalRagService.searchByText(query, {
          final_top_k: defaultTopK,
          ...config,
        });

        // 检查是否已取消
        if (cancelRef.current || requestIdRef.current !== requestId) {
          return [];
        }

        setResults(retrievalResults);
        return retrievalResults;
      } catch (err: unknown) {
        if (cancelRef.current || requestIdRef.current !== requestId) {
          return [];
        }

        const errorMessage = err instanceof Error ? err.message : t('messages.error.search_failed');
        setError(errorMessage);
        setResults([]);
        return [];
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [defaultTopK]
  );

  // 图片检索
  const searchByImage = useCallback(
    async (
      imageBase64: string,
      config?: RetrievalConfig
    ): Promise<MultimodalRetrievalResult[]> => {
      const requestId = ++requestIdRef.current;
      cancelRef.current = false;

      setLoading(true);
      setError(null);
      setLastQuery('[图片检索]');

      try {
        const retrievalResults = await multimodalRagService.searchByImage(imageBase64, 'image/png', {
          final_top_k: defaultTopK,
          ...config,
        });

        if (cancelRef.current || requestIdRef.current !== requestId) {
          return [];
        }

        setResults(retrievalResults);
        return retrievalResults;
      } catch (err: unknown) {
        if (cancelRef.current || requestIdRef.current !== requestId) {
          return [];
        }

        const errorMessage = err instanceof Error ? err.message : t('messages.error.search_failed');
        setError(errorMessage);
        setResults([]);
        return [];
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [defaultTopK]
  );

  // 混合检索
  const searchMixed = useCallback(
    async (
      query: string,
      imageBase64: string,
      config?: RetrievalConfig
    ): Promise<MultimodalRetrievalResult[]> => {
      const requestId = ++requestIdRef.current;
      cancelRef.current = false;

      setLoading(true);
      setError(null);
      setLastQuery(query || '[混合检索]');

      try {
        const retrievalResults = await multimodalRagService.searchByTextAndImage(
          query,
          imageBase64,
          'image/png',
          {
            final_top_k: defaultTopK,
            ...config,
          }
        );

        if (cancelRef.current || requestIdRef.current !== requestId) {
          return [];
        }

        setResults(retrievalResults);
        return retrievalResults;
      } catch (err: unknown) {
        if (cancelRef.current || requestIdRef.current !== requestId) {
          return [];
        }

        const errorMessage = err instanceof Error ? err.message : t('messages.error.search_failed');
        setError(errorMessage);
        setResults([]);
        return [];
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [defaultTopK]
  );

  // 清空结果
  const clearResults = useCallback(() => {
    setResults([]);
    setError(null);
    setLastQuery(null);
  }, []);

  // 取消当前请求
  const cancel = useCallback(() => {
    cancelRef.current = true;
    setLoading(false);
  }, []);

  return {
    // 状态
    loading,
    results,
    error,
    isConfigured,
    lastQuery,
    // 操作
    searchByText,
    searchByImage,
    searchMixed,
    checkConfig,
    clearResults,
    cancel,
  };
}

export default useMultimodalSearch;
