/**
 * Hook：根据单个 templateId 异步加载 CustomAnkiTemplate
 *
 * 与 useMultiTemplateLoader 共享模块级缓存与 in-flight 去重，
 * 同一模板在聊天多个块中同时使用时只会请求一次。
 * 额外提供 error / retry，便于调用方展示加载失败态并重试。
 *
 * 返回结构与旧版（re-export 的 useAnkiTemplateLoader）向后兼容：
 * `{ template, loading }` 保持不变，新增 `error`、`retry`。
 */

import { useCallback, useEffect, useState } from 'react';
import { templateManager } from '@/data/ankiTemplates';
import type { CustomAnkiTemplate } from '@/types';
import {
  clearTemplateCache,
  clearTemplateLoadFailure,
  getCachedTemplate,
  isTemplateLoadFailed,
  loadTemplateShared,
} from './useMultiTemplateLoader';

export function useTemplateLoader(templateId?: string | null) {
  const [template, setTemplate] = useState<CustomAnkiTemplate | null>(
    () => (templateId ? getCachedTemplate(templateId) ?? null : null)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    return templateManager.subscribe(() => {
      clearTemplateCache();
      setRefreshToken((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    if (!templateId) {
      setTemplate(null);
      setLoading(false);
      setError(false);
      return;
    }

    const cached = getCachedTemplate(templateId);
    if (cached) {
      setTemplate(cached);
      setLoading(false);
      setError(false);
      return;
    }

    // 已知失败的模板不自动重试，避免反复请求；等待显式 retry 或缓存清空
    if (isTemplateLoadFailed(templateId)) {
      setTemplate(null);
      setLoading(false);
      setError(true);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(false);

    loadTemplateShared(templateId).then((nextTemplate) => {
      if (cancelled) return;
      setTemplate(nextTemplate);
      setError(!nextTemplate);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [templateId, refreshToken]);

  /** 重试加载（仅在上次失败后有意义） */
  const retry = useCallback(() => {
    if (!templateId) return;
    clearTemplateLoadFailure(templateId);
    setRefreshToken((value) => value + 1);
  }, [templateId]);

  return { template, loading, error, retry };
}
