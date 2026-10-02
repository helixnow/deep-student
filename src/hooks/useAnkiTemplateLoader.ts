import { useEffect, useRef, useState } from 'react';
import { templateManager } from '@/data/ankiTemplates';
import { TemplateService } from '@/services/templateService';
import type { CustomAnkiTemplate } from '@/types';

export function useAnkiTemplateLoader(templateId?: string | null) {
  const [template, setTemplate] = useState<CustomAnkiTemplate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const cacheRef = useRef<Map<string, CustomAnkiTemplate>>(new Map());

  useEffect(() => templateManager.subscribe(() => {
    cacheRef.current.clear();
    setRefreshToken((value) => value + 1);
  }), []);

  useEffect(() => {
    if (!templateId) {
      setTemplate(null);
      setLoading(false);
      setError(null);
      return;
    }

    const cached = cacheRef.current.get(templateId);
    if (cached) {
      setTemplate(cached);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    // 未命中缓存时先清掉上一个模板：否则加载期间会用「旧模板 + 新卡字段」渲染出错配卡面
    // （复习切卡时尤其明显：选择题模板套到术语卡上，选项全空）
    setTemplate(null);
    setLoading(true);
    setError(null);
    TemplateService.getInstance()
      .getTemplateById(templateId)
      .then((nextTemplate) => {
        if (cancelled) return;
        if (nextTemplate) cacheRef.current.set(templateId, nextTemplate);
        setTemplate(nextTemplate);
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        console.error('[useAnkiTemplateLoader] Failed to load template:', templateId, loadError);
        if (cancelled) return;
        setTemplate(null);
        setLoading(false);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });

    return () => {
      cancelled = true;
    };
  }, [templateId, refreshToken]);

  // 只返回属于当前 templateId 的模板（id 切换后的首帧 effect 尚未运行，state 仍是旧模板）
  const matched = template && templateId && template.id === templateId ? template : null;
  return { template: matched, loading: loading || (Boolean(templateId) && !matched && !error), error };
}
