/**
 * usePdfLoader - 统一的 PDF 文件加载 Hook
 * 
 * 解决的问题：
 * 1. 避免 TextbookContentView 和 FileContentView 中的重复代码
 * 2. 添加请求去重/缓存机制
 * 3. 大文件加载警告（>10MB 提示，>100MB 拒绝预览）
 * 4. 统一的错误处理（错误原因经 pdfLoadErrors 分类）
 */

import { useState, useEffect, useCallback } from 'react';
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

const EMPTY_PDF_STATE: Omit<PdfLoaderState, 'retry'> = {
  file: null,
  filePath: undefined,
  loading: false,
  error: null,
  errorKind: null,
  isLargeFile: false,
  fileSize: 0,
  loadSource: null,
};

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
  const [retryVersion, setRetryVersion] = useState(0);
  const cacheStorageKey = `pdf_${JSON.stringify([nodeId, cacheKey ?? nodeId])}`;
  const requestKey = JSON.stringify([nodeId, fileName, explicitFilePath, cacheKey, enabled, retryVersion]);
  const [loaded, setLoaded] = useState<{
    requestKey: string;
    state: Omit<PdfLoaderState, 'retry'>;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const publish = (state: Partial<Omit<PdfLoaderState, 'retry'>>) => {
      if (!cancelled) {
        setLoaded({ requestKey, state: { ...EMPTY_PDF_STATE, ...state } });
      }
    };
    publish({ loading: true });

    const loadPdf = async () => {
      try {
        const filePath = explicitFilePath || await resolveStreamableBlobPath(nodeId);
        if (cancelled) return;
        if (filePath) {
          publish({ filePath, loadSource: 'stream' });
          let fileSize = 0;
          try {
            fileSize = await invoke<number>('get_file_size', { path: filePath });
          } catch {
            // Streaming can proceed when size metadata is unavailable.
          }
          publish({
            filePath,
            loadSource: 'stream',
            fileSize,
            isLargeFile: fileSize > LARGE_FILE_HINT_THRESHOLD,
          });
          return;
        }

        const cached = pdfCache.get(cacheStorageKey);
        if (cached) {
          pdfCache.delete(cacheStorageKey);
          pdfCache.set(cacheStorageKey, cached);
          publish({
            file: cached.name === fileName ? cached : new File([cached], fileName, { type: cached.type }),
            fileSize: cached.size,
            isLargeFile: cached.size > LARGE_FILE_HINT_THRESHOLD,
            loadSource: 'memory',
          });
          return;
        }

        const result = await invoke<{ content: string | null; found: boolean }>(
          'vfs_get_attachment_content',
          { attachmentId: nodeId },
        );
        if (cancelled) return;
        if (!result?.found || !result.content) {
          publish({
            error: i18n.t('pdf:errors.content_not_found', {
              defaultValue: 'Unable to load PDF file content (id: {{id}})', id: nodeId,
            }),
            errorKind: 'network',
          });
          return;
        }

        const estimatedSize = estimateBase64Size(result.content);
        if (estimatedSize > LARGE_FILE_THRESHOLD) {
          publish({
            error: i18n.t('pdf:errors.too_large', {
              defaultValue: 'PDF is too large to preview ({{size}})',
              size: formatBytes(estimatedSize),
            }),
            errorKind: 'too-large',
            fileSize: estimatedSize,
            isLargeFile: true,
          });
          return;
        }

        const conversionResult = base64ToFile(result.content, fileName, 'application/pdf');
        if (conversionResult.success && conversionResult.file) {
          cachePut(cacheStorageKey, conversionResult.file);
          publish({
            file: conversionResult.file,
            fileSize: conversionResult.file.size,
            isLargeFile: conversionResult.file.size > LARGE_FILE_HINT_THRESHOLD,
            loadSource: 'memory',
          });
        } else {
          publish({
            error: conversionResult.error || i18n.t('pdf:errors.conversion_failed', { defaultValue: 'File format conversion failed' }),
            errorKind: 'invalid',
          });
        }
      } catch (err: unknown) {
        if (cancelled) return;
        debugLog.error('[usePdfLoader] Failed to load PDF:', err);
        publish({
          error: err instanceof Error ? err.message : i18n.t('pdf:errors.load_pdf_failed', { defaultValue: 'Failed to load PDF' }),
          errorKind: classifyPdfLoadError(err).kind,
        });
      }
    };

    void loadPdf();
    return () => {
      cancelled = true;
    };
  }, [enabled, explicitFilePath, nodeId, fileName, cacheStorageKey, requestKey]);

  const retry = useCallback(() => {
    if (!enabled) return;
    const cached = pdfCache.get(cacheStorageKey);
    if (cached) {
      pdfCacheTotalSize -= cached.size;
      pdfCache.delete(cacheStorageKey);
    }
    setRetryVersion(version => version + 1);
  }, [enabled, cacheStorageKey]);

  return {
    ...(enabled && loaded?.requestKey === requestKey
      ? loaded.state
      : { ...EMPTY_PDF_STATE, loading: enabled }),
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
