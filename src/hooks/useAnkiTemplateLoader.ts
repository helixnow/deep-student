import { useEffect, useRef, useState } from 'react';
import { templateManager } from '@/data/ankiTemplates';
import { TemplateService } from '@/services/templateService';
import type { CustomAnkiTemplate } from '@/types';

export function useAnkiTemplateLoader(templateId?: string | null) {
  const [template, setTemplate] = useState<CustomAnkiTemplate | null>(null);
  const [loading, setLoading] = useState(false);
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
      return;
    }

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
      .then((nextTemplate) => {
        if (cancelled) return;
        if (nextTemplate) cacheRef.current.set(templateId, nextTemplate);
        setTemplate(nextTemplate);
        setLoading(false);
      })
      .catch((error: unknown) => {
        console.error('[useAnkiTemplateLoader] Failed to load template:', templateId, error);
        if (cancelled) return;
        setTemplate(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [templateId, refreshToken]);

  return { template, loading };
}
