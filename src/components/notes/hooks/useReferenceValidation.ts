/**
 * 引用有效性校验 Hook
 *
 * 根据文档18第八章"引用有效性校验"实现
 *
 * 改造说明（Prompt D）：
 * - 原使用 `learning_hub_*` 命令已废弃
 * - 现改用 DSTU 访达协议层 API
 *
 * 职责：
 * - 校验引用节点对应的原生数据是否仍然存在
 * - 缓存校验结果，避免重复请求
 * - 提供清理失效引用功能
 * - 提供刷新标题功能（从原数据更新）
 */

import { useState, useCallback, useRef, useMemo } from 'react';
import i18next from 'i18next';
import type { ReferenceNode, SourceDatabase } from '../types/reference';
import { getErrorMessage } from '../../../utils/errorUtils';
import { 
  validateReference as validateViaApi,
  batchValidateReferences as batchValidateViaApi,
  fetchReferenceContent as fetchContentViaApi,
  type SourceDatabase as ApiSourceDb,
} from '../learningHubApi';

// ============================================================================
// 类型定义
// ============================================================================

/** 校验结果缓存条目 */
interface ValidationCacheEntry {
  /** 是否有效 */
  valid: boolean;
  /** 校验时间（Unix 时间戳毫秒） */
  validatedAt: number;
}

/** 后端校验请求参数（对齐后端 serde camelCase 序列化） */
interface ReferenceValidateRequest {
  sourceDb: string;
  sourceId: string;
}

/** 后端校验响应（对齐后端 serde camelCase 序列化） */
interface ReferenceValidateResult {
  sourceDb: string;
  sourceId: string;
  valid: boolean;
}

/** 后端内容获取响应（对齐后端 serde camelCase 序列化） */
interface LearningHubContent {
  sourceDb: string;
  sourceId: string;
  title: string;
  contentType: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Hook 返回类型 */
export interface UseReferenceValidationReturn {
  /** 有效性状态缓存（refId -> boolean） */
  validationCache: Record<string, boolean>;
  /** 校验中的引用 ID 列表 */
  validatingIds: Set<string>;
  /** 校验单个引用 */
  validateReference: (
    refId: string,
    refNode: ReferenceNode
  ) => Promise<boolean>;
  /** 批量校验 */
  batchValidate: (
    refs: Array<{ id: string; node: ReferenceNode }>
  ) => Promise<Record<string, boolean>>;
  /** 检查引用是否失效（从缓存读取，未校验过返回 undefined） */
  isInvalid: (refId: string) => boolean | undefined;
  /** 检查引用是否已校验过 */
  isValidated: (refId: string) => boolean;
  /** 清理失效引用（返回清理数量） */
  cleanupInvalidRefs: (
    references: Record<string, ReferenceNode>,
    removeReference: (refId: string) => void
  ) => Promise<number>;
  /** 刷新引用标题（从原数据获取最新标题） */
  refreshTitle: (
    refId: string,
    refNode: ReferenceNode,
    updateReference: (refId: string, updates: Partial<Pick<ReferenceNode, 'title' | 'icon'>>) => void
  ) => Promise<void>;
  /** 清除缓存（用于切换科目时） */
  clearCache: () => void;
  /** 使指定引用的缓存失效 */
  invalidateCache: (refId: string) => void;
}

// ============================================================================
// 缓存过期时间配置
// ============================================================================

/** 缓存有效期（毫秒），默认 5 分钟 */
const CACHE_TTL = 5 * 60 * 1000;

// ============================================================================
// API 调用
// ============================================================================

/**
 * 通过 DSTU API 校验单个引用
 */
const invokeValidateReference = async (
  sourceDb: string,
  sourceId: string
): Promise<boolean> => {
  try {
    return await validateViaApi(
      sourceDb as ApiSourceDb, 
      sourceId
    );
  } catch (error) {
    console.error('[useReferenceValidation] Validate via DSTU failed:', getErrorMessage(error));
    // 校验失败时保守处理，认为有效（避免误删）
    return true;
  }
};

/**
 * 通过 DSTU API 批量校验
 */
const invokeBatchValidate = async (
  refs: ReferenceValidateRequest[]
): Promise<ReferenceValidateResult[]> => {
  try {
    const apiRefs = refs.map(ref => ({
      sourceDb: ref.sourceDb as ApiSourceDb,
      sourceId: ref.sourceId,
    }));
    return await batchValidateViaApi(apiRefs);
  } catch (error) {
    console.error('[useReferenceValidation] Batch validate via DSTU failed:', getErrorMessage(error));
    // 校验失败时保守处理，全部认为有效
    return refs.map(ref => ({
      sourceDb: ref.sourceDb,
      sourceId: ref.sourceId,
      valid: true,
    }));
  }
};

/**
 * 通过 DSTU API 获取内容
 */
const invokeFetchContent = async (
  sourceDb: string,
  sourceId: string
): Promise<LearningHubContent> => {
  const result = await fetchContentViaApi({
    sourceDb: sourceDb as ApiSourceDb,
    sourceId,
  });

  if (!result.ok) {
    throw new Error(result.error?.message || 'Failed to fetch content');
  }

  return {
    sourceDb,
    sourceId,
    title: (result.value.metadata?.title as string) || '',
    contentType: (result.value.metadata?.contentType as string) || 'unknown',
    content: result.value.content || '',
    metadata: result.value.metadata,
  };
};

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 引用有效性校验 Hook
 */
export function useReferenceValidation(): UseReferenceValidationReturn {
  // 有效性缓存：refId -> { valid, validatedAt }
  const [cacheMap, setCacheMap] = useState<Record<string, ValidationCacheEntry>>({});
  
  // 正在校验中的 ID 集合（防止重复请求）
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set());
  
  // 用于追踪请求去重
  const pendingRequests = useRef<Map<string, Promise<boolean>>>(new Map());

  /**
   * 获取缓存的有效性状态（考虑 TTL）
   */
  const getCachedValidity = useCallback(
    (refId: string): boolean | undefined => {
      const entry = cacheMap[refId];
      if (!entry) return undefined;
      
      // 检查是否过期
      if (Date.now() - entry.validatedAt > CACHE_TTL) {
        return undefined;
      }
      
      return entry.valid;
    },
    [cacheMap]
  );

  /**
   * 更新缓存
   */
  const updateCache = useCallback(
    (refId: string, valid: boolean) => {
      setCacheMap(prev => ({
        ...prev,
        [refId]: {
          valid,
          validatedAt: Date.now(),
        },
      }));
    },
    []
  );

  /**
   * 校验单个引用
   */
  const validateReference = useCallback(
    async (refId: string, refNode: ReferenceNode): Promise<boolean> => {
      // 1. 检查缓存
      const cached = getCachedValidity(refId);
      if (cached !== undefined) {
        return cached;
      }

      // 2. 检查是否已有进行中的请求（去重）
      const pending = pendingRequests.current.get(refId);
      if (pending) {
        return pending;
      }

      // 3. 发起新请求
      setValidatingIds(prev => new Set([...prev, refId]));

      const request = invokeValidateReference(refNode.sourceDb, refNode.sourceId)
        .then(valid => {
          updateCache(refId, valid);
          return valid;
        })
        .finally(() => {
          setValidatingIds(prev => {
            const next = new Set(prev);
            next.delete(refId);
            return next;
          });
          pendingRequests.current.delete(refId);
        });

      pendingRequests.current.set(refId, request);
      return request;
    },
    [getCachedValidity, updateCache]
  );

  /**
   * 批量校验
   */
  const batchValidate = useCallback(
    async (
      refs: Array<{ id: string; node: ReferenceNode }>
    ): Promise<Record<string, boolean>> => {
      const results: Record<string, boolean> = {};
      const toValidate: Array<{ id: string; node: ReferenceNode }> = [];

      // 1. 先检查缓存
      for (const { id, node } of refs) {
        const cached = getCachedValidity(id);
        if (cached !== undefined) {
          results[id] = cached;
        } else {
          toValidate.push({ id, node });
        }
      }

      // 2. 如果没有需要校验的，直接返回
      if (toValidate.length === 0) {
        return results;
      }

      // 3. 标记为校验中
      const validatingRefIds = toValidate.map(r => r.id);
      setValidatingIds(prev => new Set([...prev, ...validatingRefIds]));

      try {
        // 4. 构建请求（使用 camelCase 以匹配后端 serde 设置）
        const requests: ReferenceValidateRequest[] = toValidate.map(({ node }) => ({
          sourceDb: node.sourceDb,
          sourceId: node.sourceId,
        }));

        // 5. 发起批量校验
        const batchResults = await invokeBatchValidate(requests);

        // 6. 处理结果
        for (let i = 0; i < toValidate.length; i++) {
          const { id } = toValidate[i];
          const result = batchResults[i];
          const valid = result?.valid ?? true; // 默认有效
          
          results[id] = valid;
          updateCache(id, valid);
        }
      } finally {
        // 7. 清除校验中状态
        setValidatingIds(prev => {
          const next = new Set(prev);
          validatingRefIds.forEach(id => next.delete(id));
          return next;
        });
      }

      return results;
    },
    [getCachedValidity, updateCache]
  );

  /**
   * 检查引用是否失效
   */
  const isInvalid = useCallback(
    (refId: string): boolean | undefined => {
      const cached = getCachedValidity(refId);
      if (cached === undefined) return undefined;
      return !cached;
    },
    [getCachedValidity]
  );

  /**
   * 检查引用是否已校验过
   */
  const isValidated = useCallback(
    (refId: string): boolean => {
      return getCachedValidity(refId) !== undefined;
    },
    [getCachedValidity]
  );

  /**
   * 清理失效引用
   */
  const cleanupInvalidRefs = useCallback(
    async (
      references: Record<string, ReferenceNode>,
      removeReference: (refId: string) => void
    ): Promise<number> => {
      const refEntries = Object.entries(references);
      
      if (refEntries.length === 0) {
        return 0;
      }

      // 1. 批量校验所有引用
      const validationResults = await batchValidate(
        refEntries.map(([id, node]) => ({ id, node }))
      );

      // 2. 收集失效引用
      const invalidRefIds = Object.entries(validationResults)
        .filter(([, valid]) => !valid)
        .map(([id]) => id);

      // 3. 移除失效引用
      for (const refId of invalidRefIds) {
        removeReference(refId);
      }

      return invalidRefIds.length;
    },
    [batchValidate]
  );

  /**
   * 刷新引用标题
   */
  const refreshTitle = useCallback(
    async (
      refId: string,
      refNode: ReferenceNode,
      updateReference: (refId: string, updates: Partial<Pick<ReferenceNode, 'title' | 'icon'>>) => void
    ): Promise<void> => {
      // 1. 先校验引用是否有效
      const valid = await validateReference(refId, refNode);
      
      if (!valid) {
        throw new Error(i18next.t('notes:reference.invalid_cannot_refresh', 'Reference is invalid, cannot refresh title'));
      }

      // 2. 获取最新内容
      const content = await invokeFetchContent(refNode.sourceDb, refNode.sourceId);

      // 3. 更新标题
      if (content.title && content.title !== refNode.title) {
        updateReference(refId, { title: content.title });
      }
    },
    [validateReference]
  );

  /**
   * 清除所有缓存
   */
  const clearCache = useCallback(() => {
    setCacheMap({});
    pendingRequests.current.clear();
  }, []);

  /**
   * 使指定引用的缓存失效
   */
  const invalidateCache = useCallback((refId: string) => {
    setCacheMap(prev => {
      const next = { ...prev };
      delete next[refId];
      return next;
    });
    pendingRequests.current.delete(refId);
  }, []);

  /**
   * 导出的验证缓存（仅包含 valid 状态）
   */
  const validationCache = useMemo(() => {
    const cache: Record<string, boolean> = {};
    for (const [refId, entry] of Object.entries(cacheMap)) {
      // 只返回未过期的缓存
      if (Date.now() - entry.validatedAt <= CACHE_TTL) {
        cache[refId] = entry.valid;
      }
    }
    return cache;
  }, [cacheMap]);

  return {
    validationCache,
    validatingIds,
    validateReference,
    batchValidate,
    isInvalid,
    isValidated,
    cleanupInvalidRefs,
    refreshTitle,
    clearCache,
    invalidateCache,
  };
}

export default useReferenceValidation;
