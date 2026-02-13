import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { TauriAPI } from '../utils/tauriApi';

// 统计数据缓存配置
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存
const REFRESH_INTERVAL = 60 * 1000; // 1分钟自动刷新

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// 跨组件共享缓存与请求去重，避免同一统计接口重复请求
const globalCache = new Map<string, CacheEntry<unknown>>();
const inflightRequests = new Map<string, Promise<unknown>>();

interface UseStatisticsDataOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
  onError?: (error: Error) => void;
}

// 通用的统计数据 Hook
export function useStatisticsData<T>(
  fetcher: () => Promise<T>,
  cacheKey: string,
  options: UseStatisticsDataOptions = {}
) {
  const {
    autoRefresh = true,
    refreshInterval = REFRESH_INTERVAL,
    onError
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout>();

  // 从缓存获取数据
  const getFromCache = useCallback(() => {
    const cached = globalCache.get(cacheKey) as CacheEntry<T> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }
    return null;
  }, [cacheKey]);

  // 保存到缓存
  const saveToCache = useCallback((data: T) => {
    globalCache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });
  }, [cacheKey]);

  // 获取数据
  const fetchData = useCallback(async (isBackground = false) => {
    if (isBackground) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      // 尝试从缓存获取
      const cached = getFromCache();
      if (cached && !isBackground) {
        setData(cached);
        setLoading(false);
        return cached;
      }

      // 从API获取（同 key 并发去重）
      let request = inflightRequests.get(cacheKey) as Promise<T> | undefined;
      if (!request) {
        request = fetcher();
        inflightRequests.set(cacheKey, request as Promise<unknown>);
      }
      const result = await request;
      setData(result);
      saveToCache(result);
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      onError?.(error);
      throw error;
    } finally {
      inflightRequests.delete(cacheKey);
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [cacheKey, fetcher, getFromCache, saveToCache, onError]);

  // 手动刷新
  const refresh = useCallback(() => fetchData(true), [fetchData]);

  // 设置自动刷新
  useEffect(() => {
    if (!autoRefresh) return;
    // 避免重建多个 interval：先清理再设置
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      fetchData(true).catch(() => {
        // 背景刷新失败时静默处理
      });
    }, refreshInterval);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, refreshInterval, fetchData]);

  // 初始加载 - 延迟执行避免阻塞 UI 首帧渲染
  useEffect(() => {
    let idleHandle: number | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      fetchData().catch(() => {
        // 初始加载失败由 error state 处理
      });
    };
    if (typeof requestIdleCallback === 'function') {
      idleHandle = requestIdleCallback(run, { timeout: 100 });
    } else {
      timeoutHandle = setTimeout(run, 16); // 约一帧延迟
    }
    return () => {
      if (idleHandle !== null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    };
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    isRefreshing,
    refresh
  };
}

// 具体的统计数据 Hooks
export function useEnhancedStatistics(options?: UseStatisticsDataOptions) {
  return useStatisticsData(
    () => TauriAPI.getEnhancedStatistics(),
    'enhanced-statistics',
    options
  );
}

export function useReviewStatistics(options?: UseStatisticsDataOptions) {
  return useStatisticsData(
    () => TauriAPI.getEnhancedStatistics(),
    // 与 useEnhancedStatistics 共享缓存/请求，避免同接口双请求
    'enhanced-statistics',
    options
  );
}

// 组合所有统计数据
export function useAllStatistics(options?: UseStatisticsDataOptions) {
  const enhanced = useEnhancedStatistics(options);
  const review = useReviewStatistics(options);

  const loading = enhanced.loading || review.loading;
  const error = enhanced.error || review.error;
  const isRefreshing = enhanced.isRefreshing || review.isRefreshing;

  const refresh = useCallback(async () => {
    await Promise.all([
      enhanced.refresh(),
      review.refresh()
    ]);
  }, [enhanced, review]);

  // 关键修复：对组合数据进行 memo，避免每次渲染生成新对象导致依赖抖动
  const dataCombined = useMemo(() => ({
    enhanced: enhanced.data,
    review: review.data,
  }), [enhanced.data, review.data]);

  return {
    data: dataCombined,
    loading,
    error,
    isRefreshing,
    refresh
  };
}
