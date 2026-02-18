/**
 * usePdfLoader - 统一的 PDF 文件加载 Hook
 * 
 * 解决的问题：
 * 1. 避免 TextbookContentView 和 FileContentView 中的重复代码
 * 2. 添加请求去重/缓存机制
 * 3. 大文件加载警告
 * 4. 统一的错误处理
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { base64ToFile, isLargeBase64, estimateBase64Size } from '@/utils/base64FileUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import i18n from '@/i18n';

// 简单的内存缓存，避免重复加载同一文件（真正的 LRU + 内存大小限制）
const pdfCache = new Map<string, File>();
const MAX_CACHE_SIZE = 5; // 最多缓存 5 个文件
let pdfCacheTotalSize = 0;
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100MB total limit

/**
 * 清理缓存（LRU 策略 + 内存大小限制）
 */
function cleanCacheIfNeeded(newFileSize: number) {
  while (pdfCache.size >= MAX_CACHE_SIZE || pdfCacheTotalSize + newFileSize > MAX_CACHE_BYTES) {
    if (pdfCache.size === 0) break;
    const firstKey = pdfCache.keys().next().value;
    if (firstKey) {
      const evicted = pdfCache.get(firstKey);
      if (evicted) pdfCacheTotalSize -= evicted.size;
      pdfCache.delete(firstKey);
    }
  }
}

/**
 * PDF 加载状态
 */
export interface PdfLoaderState {
  /** PDF File 对象 */
  file: File | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 是否为大文件（>10MB） */
  isLargeFile: boolean;
  /** 文件大小（字节） */
  fileSize: number;
  /** 重试加载 */
  retry: () => void;
}

/**
 * PDF 加载 Hook 参数
 */
export interface UsePdfLoaderOptions {
  /** 节点 ID（用于从数据库加载） */
  nodeId: string;
  /** 文件名 */
  fileName: string;
  /** 本地文件路径（可选，优先使用） */
  filePath?: string;
  /** 缓存 Key（用于内容更新时失效） */
  cacheKey?: string;
  /** 是否启用（用于条件加载） */
  enabled?: boolean;
}

/**
 * 统一的 PDF 文件加载 Hook
 * 
 * 优先使用 filePath 加载本地文件，否则从数据库加载
 */
export function usePdfLoader({
  nodeId,
  fileName,
  filePath,
  cacheKey,
  enabled = true,
}: UsePdfLoaderOptions): PdfLoaderState {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLargeFile, setIsLargeFile] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  
  // 追踪当前加载请求，用于取消
  const abortControllerRef = useRef<AbortController | null>(null);
  // 追踪上一次加载的 cacheKey，避免重复加载
  const lastLoadedKeyRef = useRef<string | null>(null);
  // ★ 用 ref 追踪当前 file，避免 useCallback 依赖循环
  const fileRef = useRef<File | null>(null);

  // 从缓存获取或加载
  const loadPdf = useCallback(async () => {
    const resolvedCacheKey = cacheKey || nodeId;
    // 如果有 filePath，不需要从数据库加载
    if (filePath) {
      setFile(null);
      setLoading(false);
      setError(null);
      setIsLargeFile(false);
      setFileSize(0);
      return;
    }
    
    // 检查缓存
    const cacheStorageKey = `pdf_${resolvedCacheKey}`;
    const cached = pdfCache.get(cacheStorageKey);
    if (cached) {
      // LRU: move to end
      pdfCache.delete(cacheStorageKey);
      pdfCache.set(cacheStorageKey, cached);
      debugLog.log('[usePdfLoader] Using cached file for:', resolvedCacheKey);
      setFile(cached);
      setLoading(false);
      setError(null);
      setFileSize(cached.size);
      setIsLargeFile(cached.size > 10 * 1024 * 1024);
      return;
    }
    
    // 避免重复加载
    if (lastLoadedKeyRef.current === resolvedCacheKey && fileRef.current) {
      return;
    }
    
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    
    setLoading(true);
    setError(null);
    lastLoadedKeyRef.current = resolvedCacheKey;
    
    try {
      debugLog.log('[usePdfLoader] Loading PDF from database for:', resolvedCacheKey);
      
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: nodeId,
      });
      
      // 检查是否被取消
      if (abortControllerRef.current?.signal.aborted) {
        return;
      }
      
      if (result?.found && result?.content) {
        // 检查是否为大文件
        const estimatedSize = estimateBase64Size(result.content);
        setFileSize(estimatedSize);
        
        if (isLargeBase64(result.content)) {
          setIsLargeFile(true);
          debugLog.warn('[usePdfLoader] Large file detected:', estimatedSize, 'bytes');
        }
        
        // 转换 base64 为 File
        const conversionResult = base64ToFile(result.content, fileName, 'application/pdf');
        
        if (conversionResult.success && conversionResult.file) {
          // 缓存文件
          cleanCacheIfNeeded(conversionResult.file.size);
          pdfCache.set(cacheStorageKey, conversionResult.file);
          pdfCacheTotalSize += conversionResult.file.size;
          
          fileRef.current = conversionResult.file;
          setFile(conversionResult.file);
          setLoading(false);
        } else {
          setError(conversionResult.error || i18n.t('pdf:errors.conversion_failed', { defaultValue: 'File format conversion failed' }));
          setLoading(false);
        }
      } else {
        setError(i18n.t('pdf:errors.content_not_found', { defaultValue: 'Unable to load PDF file content (id: {{id}})', id: nodeId }));
        setLoading(false);
      }
    } catch (err: unknown) {
      // 检查是否被取消
      if (abortControllerRef.current?.signal.aborted) {
        return;
      }
      
      debugLog.error('[usePdfLoader] Failed to load PDF:', err);
      setError(err instanceof Error ? err.message : i18n.t('pdf:errors.load_pdf_failed', { defaultValue: 'Failed to load PDF' }));
      setLoading(false);
    }
  }, [nodeId, fileName, filePath, cacheKey]);

  // 当参数变化时加载
  useEffect(() => {
    if (!enabled) {
      setFile(null);
      setLoading(false);
      setError(null);
      setIsLargeFile(false);
      setFileSize(0);
      return;
    }
    
    void loadPdf();
    
    return () => {
      // 取消进行中的请求
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [enabled, loadPdf]);

  // 重试：清除上一次缓存 key 以允许重新加载
  const retry = useCallback(() => {
    lastLoadedKeyRef.current = null;
    fileRef.current = null;
    void loadPdf();
  }, [loadPdf]);

  return {
    file,
    loading,
    error,
    isLargeFile,
    fileSize,
    retry,
  };
}

/**
 * 清除 PDF 缓存
 * 可在内存压力大时调用
 */
export function clearPdfCache(): void {
  pdfCache.clear();
  pdfCacheTotalSize = 0;
  debugLog.log('[usePdfLoader] Cache cleared');
}

/**
 * 获取缓存状态
 */
export function getPdfCacheInfo(): { size: number; keys: string[] } {
  return {
    size: pdfCache.size,
    keys: Array.from(pdfCache.keys()),
  };
}
