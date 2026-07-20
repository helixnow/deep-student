/**
 * Hook：根据多个 templateId 批量异步加载 CustomAnkiTemplate
 *
 * 解决多模板渲染场景：同一批卡片可能使用不同的 template_id，
 * 需要为每张卡片加载对应的模板 HTML/CSS 以正确渲染。
 *
 * 特点：
 * - 批量加载，去重请求
 * - 模块级缓存 + in-flight 去重：跨组件实例共享，同一 templateId 并发只发一次请求
 * - 增量加载：新出现的 templateId 只加载增量部分
 * - 失败追踪与重试：failedIds 暴露加载失败的模板，retry() 只重试失败项
 */

import { useCallback, useState, useEffect, useMemo } from 'react';
import { TemplateService } from '@/services/templateService';
import { templateManager } from '@/data/ankiTemplates';
import type { CustomAnkiTemplate } from '@/types';

// ============================================================================
// 模块级共享缓存（供 useMultiTemplateLoader / useTemplateLoader 复用）
// ============================================================================

const templateCache = new Map<string, CustomAnkiTemplate>();
const inflightRequests = new Map<string, Promise<CustomAnkiTemplate | null>>();
const failedTemplateIds = new Set<string>();

/** 读取缓存中的模板（无请求副作用） */
export function getCachedTemplate(id: string): CustomAnkiTemplate | undefined {
  return templateCache.get(id);
}

/** 判断某模板是否曾加载失败 */
export function isTemplateLoadFailed(id: string): boolean {
  return failedTemplateIds.has(id);
}

/** 清除失败标记（重试前调用） */
export function clearTemplateLoadFailure(id: string): void {
  failedTemplateIds.delete(id);
}

/** 清空全部模板缓存（模板库变更时由 templateManager 订阅触发） */
export function clearTemplateCache(): void {
  templateCache.clear();
  failedTemplateIds.clear();
}

/**
 * 加载单个模板：命中缓存直接返回；已有同 id 的在途请求则复用，
 * 避免多个组件同时挂载时的重复请求。
 */
export function loadTemplateShared(id: string): Promise<CustomAnkiTemplate | null> {
  const cached = templateCache.get(id);
  if (cached) return Promise.resolve(cached);

  const pending = inflightRequests.get(id);
  if (pending) return pending;

  const request = TemplateService.getInstance()
    .getTemplateById(id)
    .then((template) => {
      if (template) {
        templateCache.set(id, template);
        failedTemplateIds.delete(id);
      } else {
        failedTemplateIds.add(id);
      }
      return template;
    })
    .catch((error: unknown) => {
      console.error('[useMultiTemplateLoader] Failed to load template:', id, error);
      failedTemplateIds.add(id);
      return null;
    })
    .finally(() => {
      inflightRequests.delete(id);
    });

  inflightRequests.set(id, request);
  return request;
}

function dispatchTemplateDebugEvent(detail: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail }));
  } catch {
    /* 调试事件失败不影响主流程 */
  }
}

// ============================================================================
// Hook
// ============================================================================

/**
 * 批量加载多个模板
 *
 * @param templateIds 需要加载的模板 ID 数组（自动去重）
 * @returns templateMap: Map<templateId, CustomAnkiTemplate>；loading: 是否正在加载；
 *          failedIds: 加载失败的模板 ID；retry: 重试失败项
 */
export function useMultiTemplateLoader(templateIds: string[]) {
  const [templateMap, setTemplateMap] = useState<Map<string, CustomAnkiTemplate>>(new Map());
  const [loading, setLoading] = useState(false);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);

  // 去重并排序（稳定引用）
  const uniqueIds = useMemo(() => {
    const set = new Set(templateIds.filter(Boolean));
    return [...set].sort();
  }, [templateIds]);

  // 序列化 key 用于依赖比较
  const idsKey = uniqueIds.join(',');

  useEffect(() => {
    return templateManager.subscribe(() => {
      clearTemplateCache();
      setRefreshToken((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    if (uniqueIds.length === 0) {
      setTemplateMap(new Map());
      setFailedIds([]);
      setLoading(false);
      return;
    }

    const buildMapFromCache = () => {
      const map = new Map<string, CustomAnkiTemplate>();
      for (const id of uniqueIds) {
        const cached = templateCache.get(id);
        if (cached) map.set(id, cached);
      }
      return map;
    };

    // 找出缓存未命中的 ID（已知失败的不自动重试，等待显式 retry 或缓存清空）
    const missingIds = uniqueIds.filter(
      (id) => !templateCache.has(id) && !failedTemplateIds.has(id)
    );

    // 全部命中缓存/失败记录：直接返回
    if (missingIds.length === 0) {
      setTemplateMap(buildMapFromCache());
      setFailedIds(uniqueIds.filter((id) => failedTemplateIds.has(id)));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    dispatchTemplateDebugEvent({
      level: 'debug',
      phase: 'template:load',
      summary: `Loading ${missingIds.length} templates: ${missingIds.join(', ')}`,
      detail: { missingIds, cachedIds: uniqueIds.filter((id) => templateCache.has(id)) },
    });

    Promise.all(
      missingIds.map((id) => loadTemplateShared(id).then((template) => ({ id, template })))
    ).then((results) => {
      if (cancelled) return;

      const loaded = results.filter((r) => r.template).map((r) => r.id);
      const failed = results.filter((r) => !r.template).map((r) => r.id);

      dispatchTemplateDebugEvent({
        level: failed.length > 0 ? 'warn' : 'info',
        phase: 'template:load',
        summary:
          `Loaded ${loaded.length}/${results.length} templates` +
          (failed.length > 0 ? ` | FAILED: ${failed.join(', ')}` : ''),
        detail: { loaded, failed },
      });

      setTemplateMap(buildMapFromCache());
      setFailedIds(uniqueIds.filter((id) => failedTemplateIds.has(id)));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [idsKey, refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 重试加载失败的模板 */
  const retry = useCallback(() => {
    let hasFailure = false;
    for (const id of uniqueIds) {
      if (failedTemplateIds.has(id)) {
        failedTemplateIds.delete(id);
        hasFailure = true;
      }
    }
    if (hasFailure) setRefreshToken((value) => value + 1);
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { templateMap, loading, failedIds, retry };
}
