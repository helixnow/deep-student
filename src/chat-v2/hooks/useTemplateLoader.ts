/**
 * Hook：根据 templateId 异步加载 CustomAnkiTemplate
 *
 * 用于 ChatAnki 卡片块在展示时加载模板的 HTML/CSS，
 * 以便用 TemplateRenderService 渲染出带样式的卡片预览。
 */

import { useState, useEffect, useRef } from 'react';
import { TemplateService } from '@/services/templateService';
import type { CustomAnkiTemplate } from '@/types';

export function useTemplateLoader(templateId?: string | null) {
  const [template, setTemplate] = useState<CustomAnkiTemplate | null>(null);
  const [loading, setLoading] = useState(false);
  // 缓存已加载的模板，避免重复请求
  const cacheRef = useRef<Map<string, CustomAnkiTemplate>>(new Map());

  useEffect(() => {
    if (!templateId) {
      setTemplate(null);
      setLoading(false);
      return;
    }

    // 缓存命中
    const cached = cacheRef.current.get(templateId);
    if (cached) {
      setTemplate(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    TemplateService.getInstance()
      .getTemplateById(templateId)
      .then((t) => {
        if (!cancelled) {
          if (t) {
            cacheRef.current.set(templateId, t);
          }
          setTemplate(t);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('[useTemplateLoader] Failed to load template:', templateId, err);
        if (!cancelled) {
          setTemplate(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [templateId]);

  return { template, loading };
}
