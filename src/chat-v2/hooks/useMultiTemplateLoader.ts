/**
 * Hook：根据多个 templateId 批量异步加载 CustomAnkiTemplate
 *
 * 解决多模板渲染场景：同一批卡片可能使用不同的 template_id，
 * 需要为每张卡片加载对应的模板 HTML/CSS 以正确渲染。
 *
 * 特点：
 * - 批量加载，去重请求
 * - 使用 useRef 做跨渲染缓存，避免重复请求
 * - 增量加载：新出现的 templateId 只加载增量部分
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { TemplateService } from '@/services/templateService';
import type { CustomAnkiTemplate } from '@/types';

/**
 * 批量加载多个模板
 *
 * @param templateIds 需要加载的模板 ID 数组（自动去重）
 * @returns templateMap: Map<templateId, CustomAnkiTemplate>，loading: 是否正在加载
 */
export function useMultiTemplateLoader(templateIds: string[]) {
  const [templateMap, setTemplateMap] = useState<Map<string, CustomAnkiTemplate>>(new Map());
  const [loading, setLoading] = useState(false);

  // 跨渲染缓存，避免同一 templateId 重复请求
  const cacheRef = useRef<Map<string, CustomAnkiTemplate>>(new Map());

  // 去重并排序（稳定引用）
  const uniqueIds = useMemo(() => {
    const set = new Set(templateIds.filter(Boolean));
    return [...set].sort();
  }, [templateIds]);

  // 序列化 key 用于依赖比较
  const idsKey = uniqueIds.join(',');

  useEffect(() => {
    if (uniqueIds.length === 0) {
      setTemplateMap(new Map());
      setLoading(false);
      return;
    }

    // 找出缓存未命中的 ID
    const missingIds = uniqueIds.filter((id) => !cacheRef.current.has(id));

    // 全部命中缓存：直接返回
    if (missingIds.length === 0) {
      const map = new Map<string, CustomAnkiTemplate>();
      for (const id of uniqueIds) {
        const cached = cacheRef.current.get(id);
        if (cached) map.set(id, cached);
      }
      setTemplateMap(map);
      setLoading(false);
      return;
    }

    // 需要加载
    let cancelled = false;
    setLoading(true);

    const service = TemplateService.getInstance();

    // 记录加载开始
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'debug', phase: 'template:load',
        summary: `Loading ${missingIds.length} templates: ${missingIds.join(', ')}`,
        detail: { missingIds, cachedIds: uniqueIds.filter((id) => cacheRef.current.has(id)) },
      }}));
    } catch { /* */ }

    Promise.all(
      missingIds.map((id) =>
        service
          .getTemplateById(id)
          .then((t) => ({ id, template: t }))
          .catch(() => ({ id, template: null }))
      )
    ).then((results) => {
      if (cancelled) return;

      // 写入缓存
      const loaded: string[] = [];
      const failed: string[] = [];
      for (const { id, template } of results) {
        if (template) {
          cacheRef.current.set(id, template);
          loaded.push(id);
        } else {
          failed.push(id);
        }
      }

      // 记录加载结果
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: failed.length > 0 ? 'warn' : 'info',
          phase: 'template:load',
          summary: `Loaded ${loaded.length}/${results.length} templates` + (failed.length > 0 ? ` | FAILED: ${failed.join(', ')}` : ''),
          detail: { loaded, failed },
        }}));
      } catch { /* */ }

      // 构建完整 map
      const map = new Map<string, CustomAnkiTemplate>();
      for (const id of uniqueIds) {
        const cached = cacheRef.current.get(id);
        if (cached) map.set(id, cached);
      }
      setTemplateMap(map);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  return { templateMap, loading };
}
