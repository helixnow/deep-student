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

  return { template, loading, error };
}
