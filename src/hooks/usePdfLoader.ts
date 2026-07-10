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
import { base64ToFile, estimateBase64Size, LARGE_FILE_THRESHOLD } from '@/utils/base64FileUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import i18n from '@/i18n';

// 简单的内存缓存，避免重复加载同一文件（真正的 LRU + 内存大小限制）
const pdfCache = new Map<string, File>();
const MAX_CACHE_SIZE = 5; // 最多缓存 5 个文件
let pdfCacheTotalSize = 0;
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100MB total limit
const LARGE_FILE_HINT_THRESHOLD = 10 * 1024 * 1024;

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

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
  /** PDF File 对象（无可用 stream 路径时从 base64 构建） */
  file: File | null;
  /** pdfstream:// 可用的本地路径（优先于 file，避免大文件 base64 过 IPC） */
  filePath: string | undefined;
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
async function resolveStreamableBlobPath(nodeId: string): Promise<string | undefined> {
  try {
    const blobPath = await invoke<string | null>('vfs_get_file_blob_path', { id: nodeId });
    if (!blobPath) return undefined;

    const access = await invoke<{ available: boolean; reason?: string }>(
      'pdfstream_check_access',
      { path: blobPath }
    );
    if (access?.available) {
      return blobPath;
    }
    debugLog.warn('[usePdfLoader] blob path not streamable:', blobPath, access?.reason);
  } catch (err: unknown) {
    debugLog.warn('[usePdfLoader] blob path resolution failed:', err);
  }
  return undefined;
}

export function usePdfLoader({
  nodeId,
  fileName,
  filePath: explicitFilePath,
  cacheKey,
  enabled = true,
}: UsePdfLoaderOptions): PdfLoaderState {
  const [file, setFile] = useState<File | null>(null);
  const [resolvedFilePath, setResolvedFilePath] = useState<string | undefined>(explicitFilePath);
  /** 无显式 filePath 时，需等待 blob 路径探测完成再决定 stream / base64 */
  const [streamPathReady, setStreamPathReady] = useState<boolean>(Boolean(explicitFilePath));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLargeFile, setIsLargeFile] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  
  // 追踪当前加载请求，用于取消
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  // 追踪上一次加载的 cacheKey，避免重复加载
  const lastLoadedKeyRef = useRef<string | null>(null);
  // ★ 用 ref 追踪当前 file，避免 useCallback 依赖循环
  const fileRef = useRef<File | null>(null);

  // 解析 VFS blob 路径（file 附件 / 教材 fallback 共用）
  useEffect(() => {
    if (!enabled) {
      setResolvedFilePath(undefined);
      setStreamPathReady(false);
      return;
    }
    if (explicitFilePath) {
      setResolvedFilePath(explicitFilePath);
      setStreamPathReady(true);
      return;
    }

    let cancelled = false;
    setStreamPathReady(false);
    setResolvedFilePath(undefined);
    void resolveStreamableBlobPath(nodeId).then((path) => {
      if (cancelled) return;
      setResolvedFilePath(path);
      setStreamPathReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, explicitFilePath, nodeId]);

  const effectiveFilePath = resolvedFilePath;

  // 从缓存获取或加载
  const loadPdf = useCallback(async () => {
    const resolvedCacheKey = cacheKey || nodeId;
    const requestId = ++requestIdRef.current;

    // 取消之前的请求（必须在任何早返回之前执行）
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // 如果有可流式读取的本地路径，不需要整文件 base64 过 IPC
    if (effectiveFilePath) {
      abortControllerRef.current = null;
      setFile(null);
      setLoading(false);
      setError(null);
      setIsLargeFile(false);
      try {
        const size = await invoke<number>('get_file_size', { path: effectiveFilePath });
        setFileSize(size);
        setIsLargeFile(size > LARGE_FILE_HINT_THRESHOLD);
      } catch {
        setFileSize(0);
        setIsLargeFile(false);
      }
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
      setIsLargeFile(cached.size > LARGE_FILE_HINT_THRESHOLD);
      return;
    }
    
    // 避免重复加载
    if (lastLoadedKeyRef.current === resolvedCacheKey && fileRef.current) {
      return;
    }
    
    setLoading(true);
    setError(null);
    lastLoadedKeyRef.current = resolvedCacheKey;
    
    try {
      debugLog.log('[usePdfLoader] Loading PDF from database for:', resolvedCacheKey);
      
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: nodeId,
      });
      
      // 检查是否被取消
      if (controller.signal.aborted || requestId !== requestIdRef.current) {
        return;
      }
      
      if (result?.found && result?.content) {
        // 检查是否为大文件
        const estimatedSize = estimateBase64Size(result.content);
        setFileSize(estimatedSize);
        const isLarge = estimatedSize > LARGE_FILE_HINT_THRESHOLD;
        setIsLargeFile(isLarge);

        if (isLarge) {
          debugLog.warn('[usePdfLoader] Large file detected:', estimatedSize, 'bytes');
        }

        // 在 base64->Uint8Array 转换前熔断，避免大文件解码导致内存峰值过高
        if (estimatedSize > LARGE_FILE_THRESHOLD) {
          setError(
            `${i18n.t('learningHub:file.previewTooLarge', { defaultValue: 'File is too large to preview' })} (${formatBytes(estimatedSize)})`
          );
          setLoading(false);
          return;
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
      if (controller.signal.aborted || requestId !== requestIdRef.current) {
        return;
      }
      
      debugLog.error('[usePdfLoader] Failed to load PDF:', err);
      setError(err instanceof Error ? err.message : i18n.t('pdf:errors.load_pdf_failed', { defaultValue: 'Failed to load PDF' }));
      setLoading(false);
    }
  }, [nodeId, fileName, effectiveFilePath, cacheKey]);

  // 当参数变化时加载（等待 blob 路径探测完成，避免误走 base64）
  useEffect(() => {
    if (!enabled) {
      setFile(null);
      setResolvedFilePath(explicitFilePath);
      setStreamPathReady(Boolean(explicitFilePath));
      setLoading(false);
      setError(null);
      setIsLargeFile(false);
      setFileSize(0);
      return;
    }

    if (!streamPathReady) {
      setLoading(true);
      return;
    }

    void loadPdf();

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [enabled, explicitFilePath, loadPdf, streamPathReady]);

  // 重试：清除上一次缓存 key 以允许重新加载
  const retry = useCallback(() => {
    lastLoadedKeyRef.current = null;
    fileRef.current = null;
    void loadPdf();
  }, [loadPdf]);

  return {
    file,
    filePath: effectiveFilePath,
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
