/**
 * Learning Hub 教材封面生成 Hook
 * 
 * 复用 TextbookLibrary 的 PDF 封面渲染逻辑
 * 使用 pdfjs 在前端生成 PDF 首页缩略图
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { TauriAPI } from '@/utils/tauriApi';
import type { ResourceListItem } from './types';
import { PDF_OPTIONS } from '@/utils/pdfConfig';

// 封面缓存类型
interface CoverCacheEntry {
  dataUrl: string;
  size: number;
  dpr: number;
  width: number;
}

// 缓存 key 格式：path
type CoverCache = Record<string, CoverCacheEntry>;

// 全局 pdfjs 实例（懒加载）
let coverPdfjs: any = null;

/**
 * 确保 pdfjs legacy 实例加载
 */
const ensureCoverPdfjs = async () => {
  if (coverPdfjs) return coverPdfjs;
  // ★ 统一使用主入口，与 TextbookPdfViewer 保持一致
  const mod: any = await import('pdfjs-dist');
  try {
    // pdfjs-dist 5.4.296 使用 .mjs 格式
    mod.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  } catch {}
  coverPdfjs = mod;
  return coverPdfjs;
};

/**
 * 教材封面生成 Hook
 * 
 * @param textbooks 教材列表（需要包含 path 和 size 字段）
 * @param viewMode 视图模式（影响目标分辨率）
 */
export function useTextbookCover(
  textbooks: ResourceListItem[],
  viewMode: 'list' | 'grid' = 'grid'
) {
  // 封面 URL 缓存：id -> dataUrl
  const [covers, setCovers] = useState<Record<string, string | null>>({});
  // 内存缓存：path -> CoverCacheEntry
  const [coverCache, setCoverCache] = useState<CoverCache>({});
  
  // 追踪正在加载的任务
  const loadingRef = useRef<Set<string>>(new Set());
  
  // 初始化时从 localStorage 读取缓存
  useEffect(() => {
    try {
      const rawV2 = localStorage.getItem('textbook_cover_cache_v2');
      if (rawV2) {
        setCoverCache(JSON.parse(rawV2));
      }
    } catch {}
  }, []);

  /**
   * 渲染 PDF 首页为 DataURL
   */
  const renderFirstPageToDataUrl = useCallback(
    async (item: ResourceListItem): Promise<string | null> => {
      if (!item.path || !item.size) return null;
      
      try {
        const pdfjs = await ensureCoverPdfjs();
        
        // 分辨率目标：按设备像素比渲染
        const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const targetCssWidth = viewMode === 'grid' ? 420 : 320;
        const desiredWidth = Math.round(targetCssWidth * dpr);

        // 检查缓存
        const cached = coverCache[item.path];
        if (
          cached &&
          typeof cached.dataUrl === 'string' &&
          cached.size === item.size &&
          cached.dpr >= dpr &&
          cached.width >= targetCssWidth
        ) {
          return cached.dataUrl;
        }

        const bytes = await TauriAPI.readFileAsBytes(item.path);
        const loadingTask = pdfjs.getDocument({ data: bytes, ...PDF_OPTIONS });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(0.5, Math.min(4.0, desiredWidth / baseViewport.width));
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        (ctx as any).imageSmoothingEnabled = true;
        (ctx as any).imageSmoothingQuality = 'high';
        
        await page.render({ canvasContext: ctx, viewport }).promise;

        // 优先使用 webp
        let dataUrl = '';
        try {
          dataUrl = canvas.toDataURL('image/webp', 0.92);
          if (!/^data:image\/webp/i.test(dataUrl)) {
            dataUrl = canvas.toDataURL('image/png');
          }
        } catch {
          dataUrl = canvas.toDataURL('image/png');
        }

        // 保存到磁盘缓存
        try {
          const pure = dataUrl.startsWith('data:') ? (dataUrl.split(',')[1] || '') : dataUrl;
          const safeId = (item.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
          const rel = `textbook_thumbs/${safeId}-w${targetCssWidth}-d${dpr}.webp`;
          const savedRel = await TauriAPI.saveImageToImagesDir(pure, rel);
          // 生成可显示的文件 URL
          try {
            const appDir = await TauriAPI.getAppDataDir();
            const abs = `${appDir}/${savedRel}`;
            const fileUrl = convertFileSrc(abs);
            dataUrl = fileUrl || dataUrl;
          } catch {}
        } catch {}

        // 更新内存缓存
        const nextCache = {
          ...coverCache,
          [item.path]: { dataUrl, size: item.size, dpr, width: targetCssWidth },
        };
        setCoverCache(nextCache);
        
        // 持久化到 localStorage
        try {
          localStorage.setItem('textbook_cover_cache_v2', JSON.stringify(nextCache));
        } catch {}

        return dataUrl;
      } catch (e) {
        console.debug('[useTextbookCover] 生成封面失败:', e);
        return null;
      }
    },
    [coverCache, viewMode]
  );

  /**
   * 获取封面 URL
   * 如果缓存中没有，返回 null（会触发异步加载）
   */
  const getCover = useCallback((id: string): string | null => {
    return covers[id] ?? null;
  }, [covers]);

  /**
   * 懒加载封面
   */
  useEffect(() => {
    let cancelled = false;
    const concurrency = 3;
    
    // 过滤出需要加载封面的教材
    const pending = textbooks.filter(
      (item) =>
        item.type === 'textbook' &&
        item.path &&
        covers[item.id] === undefined &&
        !loadingRef.current.has(item.id)
    );
    
    if (pending.length === 0) return;
    
    let cursor = 0;
    
    const worker = async () => {
      while (!cancelled) {
        const idx = cursor++;
        if (idx >= pending.length) return;
        
        const item = pending[idx];
        loadingRef.current.add(item.id);
        
        try {
          const dataUrl = await renderFirstPageToDataUrl(item);
          if (cancelled) return;
          
          setCovers((prev) => (prev[item.id] !== undefined ? prev : { ...prev, [item.id]: dataUrl }));
        } catch {}
        
        loadingRef.current.delete(item.id);
      }
    };
    
    Promise.all(Array.from({ length: concurrency }).map(() => worker()));
    
    return () => {
      cancelled = true;
    };
  }, [textbooks, covers, renderFirstPageToDataUrl]);

  return {
    covers,
    getCover,
  };
}

export default useTextbookCover;
