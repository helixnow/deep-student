/**
 * usePdfLoader - 统一的 PDF 文件加载 Hook
 * 
 * 解决的问题：
 * 1. 避免 TextbookContentView 和 FileContentView 中的重复代码
 * 2. 添加请求去重/缓存机制
 * 3. 大文件加载警告（>10MB 提示，>100MB 拒绝预览）
 * 4. 统一的错误处理（错误原因经 pdfLoadErrors 分类）
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { base64ToFile, estimateBase64Size, LARGE_FILE_THRESHOLD } from '@/utils/base64FileUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import i18n from '@/i18n';
import {
  classifyPdfLoadError,
  type PdfLoadErrorKind,
} from '@/features/learning-hub/apps/views/pdfLoadErrors';

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
 * 写入缓存（LRU 淘汰 + 总内存上限）。
 * ★ 计数修复：同 key 覆盖写入时先扣除旧条目大小，
 * 否则并发加载同一文件会让 pdfCacheTotalSize 只增不减、提前触发淘汰。
 */
function cachePut(key: string, file: File): void {
  const existing = pdfCache.get(key);
  if (existing) {
    pdfCacheTotalSize -= existing.size;
    pdfCache.delete(key);
  }
  while (pdfCache.size >= MAX_CACHE_SIZE || pdfCacheTotalSize + file.size > MAX_CACHE_BYTES) {
    if (pdfCache.size === 0) break;
    const firstKey = pdfCache.keys().next().value;
    if (firstKey === undefined) break;
    const evicted = pdfCache.get(firstKey);
    if (evicted) pdfCacheTotalSize -= evicted.size;
    pdfCache.delete(firstKey);
  }
  pdfCache.set(key, file);
  pdfCacheTotalSize += file.size;
}

/** PDF 内容的实际来源（供 UI 显示"流式/内存"标识） */
export type PdfLoadSource = 'stream' | 'memory';

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
  /** 错误分类（pdfLoadErrors），无错误时为 null */
  errorKind: PdfLoadErrorKind | null;
  /** 是否为大文件（>10MB） */
  isLargeFile: boolean;
  /** 文件大小（字节） */
  fileSize: number;
  /** 加载来源：stream=pdfstream 流式；memory=base64 整文件进内存；未就绪为 null */
  loadSource: PdfLoadSource | null;
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
  const [errorKind, setErrorKind] = useState<PdfLoadErrorKind | null>(null);
  const [isLargeFile, setIsLargeFile] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  const [loadSource, setLoadSource] = useState<PdfLoadSource | null>(null);
  
  // 追踪当前加载请求，用于取消
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  // 追踪上一次加载的 cacheKey，避免重复加载
  const lastLoadedKeyRef = useRef<string | null>(null);
  // ★ 用 ref 追踪当前 file，避免 useCallback 依赖循环
  const fileRef = useRef<File | null>(null);

  const setClassifiedError = useCallback((message: string, kind: PdfLoadErrorKind) => {
    setError(message);
    setErrorKind(kind);
    setLoading(false);
  }, []);

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
      // ★ 走 stream 分支时清掉 base64 去重标记：file state 被置 null 后，
      // 若之后切回无 stream 路径的同一 key 且缓存已被 LRU 淘汰，
      // 残留的 lastLoadedKeyRef+fileRef 会让去重判断误判"已加载"而
      // 直接 early return，导致 file 永远为 null（空白预览且无错误）。
      lastLoadedKeyRef.current = null;
      fileRef.current = null;
      setFile(null);
      setLoading(false);
      setError(null);
      setErrorKind(null);
      setIsLargeFile(false);
      setLoadSource('stream');
      try {
        const size = await invoke<number>('get_file_size', { path: effectiveFilePath });
        // ★ 竞态防护：await 期间可能已切换到别的文件，丢弃过期结果
        if (requestId !== requestIdRef.current) return;
        setFileSize(size);
        setIsLargeFile(size > LARGE_FILE_HINT_THRESHOLD);
      } catch {
        if (requestId !== requestIdRef.current) return;
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
      lastLoadedKeyRef.current = resolvedCacheKey;
      fileRef.current = cached;
      setFile(cached);
      setLoading(false);
      setError(null);
      setErrorKind(null);
      setFileSize(cached.size);
      setIsLargeFile(cached.size > LARGE_FILE_HINT_THRESHOLD);
      setLoadSource('memory');
      return;
    }
    
    // 避免重复加载（fileRef 仅在"当前 key 加载成功"时非空，见下方置空）
    if (lastLoadedKeyRef.current === resolvedCacheKey && fileRef.current) {
      return;
    }
    
    setLoading(true);
    setError(null);
    setErrorKind(null);
    setLoadSource(null);
    lastLoadedKeyRef.current = resolvedCacheKey;
    // ★ 换 key 开始新加载时清掉旧 file 引用：否则上面的去重判断会拿
    // "旧 key 的成功结果"当作"本 key 已加载"，在效果重跑时先 abort 掉
    // 在途请求又提前返回，loading 永远停不下来。
    fileRef.current = null;
    
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
          // >10MB：仅提示（isLargeFile 供 UI 显示"加载可能较慢"），不阻断
          debugLog.warn('[usePdfLoader] Large file detected:', formatBytes(estimatedSize));
        }

        // >100MB：在 base64->Uint8Array 转换前熔断，
        // 避免整文件解码导致内存峰值过高（保留拒绝策略）
        if (estimatedSize > LARGE_FILE_THRESHOLD) {
          setClassifiedError(
            i18n.t('pdf:errors.too_large', {
              defaultValue: 'PDF is too large to preview ({{size}})',
              size: formatBytes(estimatedSize),
            }),
            'too-large'
          );
          return;
        }
        
        // 转换 base64 为 File
        const conversionResult = base64ToFile(result.content, fileName, 'application/pdf');
        
        if (conversionResult.success && conversionResult.file) {
          // 缓存文件（cachePut 内部处理同 key 覆盖与 LRU 淘汰的计数）
          cachePut(cacheStorageKey, conversionResult.file);
          
          fileRef.current = conversionResult.file;
          setFile(conversionResult.file);
          setLoadSource('memory');
          setLoading(false);
        } else {
          setClassifiedError(
            conversionResult.error || i18n.t('pdf:errors.conversion_failed', { defaultValue: 'File format conversion failed' }),
            'invalid'
          );
        }
      } else {
        // 内容取不到：按"路径/资源失效"分类，UI 可走重新关联引导
        setClassifiedError(
          i18n.t('pdf:errors.content_not_found', { defaultValue: 'Unable to load PDF file content (id: {{id}})', id: nodeId }),
          'network'
        );
      }
    } catch (err: unknown) {
      // 检查是否被取消
      if (controller.signal.aborted || requestId !== requestIdRef.current) {
        return;
      }
      
      debugLog.error('[usePdfLoader] Failed to load PDF:', err);
      const classified = classifyPdfLoadError(err);
      setClassifiedError(
        err instanceof Error ? err.message : i18n.t('pdf:errors.load_pdf_failed', { defaultValue: 'Failed to load PDF' }),
        classified.kind
      );
    }
  }, [nodeId, fileName, effectiveFilePath, cacheKey, setClassifiedError]);

  // 当参数变化时加载（等待 blob 路径探测完成，避免误走 base64）
  useEffect(() => {
    if (!enabled) {
      setFile(null);
      setResolvedFilePath(explicitFilePath);
      setStreamPathReady(Boolean(explicitFilePath));
      setLoading(false);
      setError(null);
      setErrorKind(null);
      setIsLargeFile(false);
      setFileSize(0);
      setLoadSource(null);
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
    errorKind,
    isLargeFile,
    fileSize,
    loadSource,
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
