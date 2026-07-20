/**
 * 多模态知识库检索 Hook
 *
 * 提供多模态知识库的检索功能，支持：
 * - 文本检索
 * - 图片检索（支持自定义 MIME 类型）
 * - 混合检索
 * - 配置状态检查、请求取消、卸载保护
 *
 * 设计文档: docs/multimodal-user-memory-design.md
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import multimodalRagService, {
  type MultimodalRetrievalResult,
  type MultimodalCapabilityStatus,
  type RetrievalConfig,
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

/** 错误分类：供 UI 区分"未配置 / 熔断 / 网络 / 未知"给出不同引导。 */
export type MultimodalSearchErrorKind =
  | 'not_configured'
  | 'circuit_open'
  | 'network'
  | 'unknown';

export interface MultimodalSearchState {
  /** 是否正在加载 */
  loading: boolean;
  /** 检索结果 */
  results: MultimodalRetrievalResult[];
  /** 错误信息 */
  error: string | null;
  /** 错误分类（error 非空时有效） */
  errorKind: MultimodalSearchErrorKind | null;
  /** 多模态知识库是否已配置 */
  isConfigured: boolean | null;
  /** 最近一次能力探测状态 */
  capabilityStatus: MultimodalCapabilityStatus | null;
  /** 最近一次查询 */
  lastQuery: string | null;
}

export interface MultimodalSearchActions {
  /** 文本检索 */
  searchByText: (query: string, config?: RetrievalConfig) => Promise<MultimodalRetrievalResult[]>;
  /** 图片检索；mediaType 缺省为 image/png */
  searchByImage: (
    imageBase64: string,
    mediaType?: string,
    config?: RetrievalConfig
  ) => Promise<MultimodalRetrievalResult[]>;
  /** 混合检索（文本+图片）；mediaType 缺省为 image/png */
  searchMixed: (
    query: string,
    imageBase64: string,
    mediaType?: string,
    config?: RetrievalConfig
  ) => Promise<MultimodalRetrievalResult[]>;
  /** 检查配置状态 */
  checkConfig: () => Promise<boolean>;
  /** 清空结果 */
  clearResults: () => void;
  /** 取消当前请求（使进行中请求的结果全部作废） */
  cancel: () => void;
}

export type UseMultimodalSearchReturn = MultimodalSearchState & MultimodalSearchActions;

// ============================================================================
// 错误分类
// ============================================================================

function classifySearchError(
  err: unknown,
  capability: MultimodalCapabilityStatus | null
): MultimodalSearchErrorKind {
  if (capability?.reason === 'not_configured') return 'not_configured';
  if (capability?.capability?.circuitOpen) return 'circuit_open';

  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (message.includes('not configured') || message.includes('未配置')) return 'not_configured';
  if (message.includes('circuit') || message.includes('熔断')) return 'circuit_open';
  if (
    message.includes('network')
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('connection')
    || message.includes('连接')
    || message.includes('超时')
  ) {
    return 'network';
  }
  return 'unknown';
}

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
  const [errorKind, setErrorKind] = useState<MultimodalSearchErrorKind | null>(null);
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
  const [capabilityStatus, setCapabilityStatus] = useState<MultimodalCapabilityStatus | null>(null);
  const [lastQuery, setLastQuery] = useState<string | null>(null);

  // 请求序号：cancel() 与新请求都会 bump，使旧请求的回调全部失效。
  const requestIdRef = useRef(0);
  // 卸载保护：卸载后不再 setState。
  const mountedRef = useRef(true);
  // 最近一次能力状态（供错误分类使用，避免闭包读到过期 state）。
  const capabilityRef = useRef<MultimodalCapabilityStatus | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 卸载即视为取消所有进行中的请求
      requestIdRef.current += 1;
    };
  }, []);

  // 检查配置和运行时可用性；服务层不会缓存临时故障。
  const checkConfig = useCallback(async (): Promise<boolean> => {
    // getCapabilityStatus 自身不抛错：IPC 失败会返回 reason: 'probe_failed'。
    const status = await multimodalRagService.getCapabilityStatus();
    const configured = status.configured && status.available;
    capabilityRef.current = status;
    if (mountedRef.current) {
      setCapabilityStatus(status);
      setIsConfigured(configured);
    }
    return configured;
  }, []);

  // 初始化时检查配置（使用 useEffect 避免渲染期间副作用）
  useEffect(() => {
    if (autoCheckConfig && isConfigured === null) {
      checkConfig();
    }
  }, [autoCheckConfig, isConfigured, checkConfig]);

  /** 统一执行检索：处理取消、卸载、错误分类与状态更新。 */
  const runSearch = useCallback(
    async (
      queryLabel: string,
      exec: () => Promise<MultimodalRetrievalResult[]>
    ): Promise<MultimodalRetrievalResult[]> => {
      const requestId = ++requestIdRef.current;
      const isStale = () => !mountedRef.current || requestIdRef.current !== requestId;

      setLoading(true);
      setError(null);
      setErrorKind(null);
      setLastQuery(queryLabel);

      try {
        const retrievalResults = await exec();
        if (isStale()) return [];

        setResults(retrievalResults);
        return retrievalResults;
      } catch (err: unknown) {
        if (isStale()) return [];

        const errorMessage = err instanceof Error ? err.message : t('messages.error.search_failed');
        setError(errorMessage);
        setErrorKind(classifySearchError(err, capabilityRef.current));
        setResults([]);
        return [];
      } finally {
        if (!isStale()) {
          setLoading(false);
        }
      }
    },
    []
  );

  // 文本检索
  const searchByText = useCallback(
    (query: string, config?: RetrievalConfig) =>
      runSearch(query, () =>
        multimodalRagService.searchByText(query, { topK: defaultTopK, ...config })
      ),
    [defaultTopK, runSearch]
  );

  // 图片检索
  const searchByImage = useCallback(
    (imageBase64: string, mediaType: string = 'image/png', config?: RetrievalConfig) =>
      runSearch('[图片检索]', () =>
        multimodalRagService.searchByImage(imageBase64, mediaType, {
          topK: defaultTopK,
          ...config,
        })
      ),
    [defaultTopK, runSearch]
  );

  // 混合检索
  const searchMixed = useCallback(
    (
      query: string,
      imageBase64: string,
      mediaType: string = 'image/png',
      config?: RetrievalConfig
    ) =>
      runSearch(query || '[混合检索]', () =>
        multimodalRagService.searchByTextAndImage(query, imageBase64, mediaType, {
          topK: defaultTopK,
          ...config,
        })
      ),
    [defaultTopK, runSearch]
  );

  // 清空结果
  const clearResults = useCallback(() => {
    setResults([]);
    setError(null);
    setErrorKind(null);
    setLastQuery(null);
  }, []);

  // 取消当前请求：bump requestId 使进行中的请求全部作废
  const cancel = useCallback(() => {
    requestIdRef.current += 1;
    if (mountedRef.current) {
      setLoading(false);
    }
  }, []);

  return {
    // 状态
    loading,
    results,
    error,
    errorKind,
    isConfigured,
    capabilityStatus,
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
