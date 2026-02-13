/**
 * Chat V2 - VFS Blob 访问 API
 *
 * 封装 vfs_get_blob_base64 命令调用，用于获取 VFS blobs 中存储的图片。
 * 主要用于题目集识别等模块的图片显示和上下文注入。
 *
 * @see 25-题目集识别VFS存储与多模态上下文注入改造.md
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '../../debug-panel/debugMasterSwitch';

const LOG_PREFIX = '[BlobApi]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * vfs_get_blob_base64 返回结果
 */
export interface VfsBlobBase64Result {
  /** Base64 编码的文件内容（不含 data: 前缀） */
  base64: string;
  /** MIME 类型（如 "image/jpeg"） */
  mimeType: string;
  /** 文件大小（字节） */
  size: number;
}

/**
 * 获取 blob 的选项
 */
export interface GetBlobOptions {
  /** 是否返回 data URL 格式（默认 false，返回纯 base64） */
  asDataUrl?: boolean;
}

// ============================================================================
// 缓存管理
// ============================================================================

/**
 * Blob 缓存（避免重复请求）
 * key: blob_hash, value: VfsBlobBase64Result
 */
const blobCache = new Map<string, VfsBlobBase64Result>();

/**
 * 最大缓存数量
 */
const MAX_CACHE_SIZE = 50;

/**
 * 清理最旧的缓存条目
 */
function evictOldestCacheEntry(): void {
  if (blobCache.size >= MAX_CACHE_SIZE) {
    const firstKey = blobCache.keys().next().value;
    if (firstKey) {
      blobCache.delete(firstKey);
    }
  }
}

// ============================================================================
// API 实现
// ============================================================================

/**
 * 获取 Blob 的 Base64 数据
 *
 * @param blobHash Blob 的 SHA-256 哈希值
 * @param options 获取选项
 * @returns Blob 的 Base64 数据和元信息
 *
 * @example
 * ```typescript
 * // 获取纯 base64 数据
 * const result = await getBlobBase64('abc123...');
 * console.log(result.base64, result.mimeType);
 *
 * // 获取 data URL 格式
 * const dataUrl = await getBlobAsDataUrl('abc123...');
 * imgElement.src = dataUrl;
 * ```
 */
export async function getBlobBase64(
  blobHash: string,
  options: GetBlobOptions = {}
): Promise<VfsBlobBase64Result> {
  const { asDataUrl = false } = options;

  // 检查缓存
  const cached = blobCache.get(blobHash);
  if (cached) {
    console.debug(`${LOG_PREFIX} Cache hit for blob: ${blobHash.slice(0, 8)}...`);
    return cached;
  }

  try {
    console.debug(`${LOG_PREFIX} Fetching blob: ${blobHash.slice(0, 8)}...`);
    
    const result = await invoke<VfsBlobBase64Result>('vfs_get_blob_base64', {
      blobHash,
    });

    // 添加到缓存
    evictOldestCacheEntry();
    blobCache.set(blobHash, result);

    console.debug(
      `${LOG_PREFIX} Blob fetched: ${blobHash.slice(0, 8)}..., size=${result.size} bytes`
    );

    return result;
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    console.error(`${LOG_PREFIX} Failed to fetch blob ${blobHash.slice(0, 8)}...: ${message}`);
    throw new Error(`获取图片失败: ${message}`);
  }
}

/**
 * 获取 Blob 作为 Data URL
 *
 * @param blobHash Blob 的 SHA-256 哈希值
 * @returns Data URL 格式的字符串（如 "data:image/jpeg;base64,..."）
 *
 * @example
 * ```typescript
 * const dataUrl = await getBlobAsDataUrl('abc123...');
 * imgElement.src = dataUrl;
 * ```
 */
export async function getBlobAsDataUrl(blobHash: string): Promise<string> {
  const result = await getBlobBase64(blobHash);
  return `data:${result.mimeType};base64,${result.base64}`;
}

/**
 * 批量获取 Blob 的 Data URL
 *
 * @param blobHashes Blob 哈希值数组
 * @returns Data URL 数组（顺序与输入一致，失败的条目为 null）
 */
export async function getBlobsAsDataUrls(
  blobHashes: string[]
): Promise<(string | null)[]> {
  const results = await Promise.all(
    blobHashes.map(async (hash) => {
      try {
        return await getBlobAsDataUrl(hash);
      } catch {
        return null;
      }
    })
  );
  return results;
}

/**
 * 预加载 Blob 到缓存（不返回结果）
 *
 * @param blobHashes Blob 哈希值数组
 */
export async function preloadBlobs(blobHashes: string[]): Promise<void> {
  await Promise.all(
    blobHashes.map(async (hash) => {
      try {
        await getBlobBase64(hash);
      } catch {
        // 忽略预加载错误
      }
    })
  );
}

/**
 * 清除 Blob 缓存
 *
 * @param blobHash 可选，指定清除某个 blob 的缓存；不传则清除全部
 */
export function clearBlobCache(blobHash?: string): void {
  if (blobHash) {
    blobCache.delete(blobHash);
  } else {
    blobCache.clear();
  }
}

/**
 * 获取缓存统计信息
 */
export function getBlobCacheStats(): { size: number; maxSize: number } {
  return {
    size: blobCache.size,
    maxSize: MAX_CACHE_SIZE,
  };
}

// ============================================================================
// 导出统一 API 对象
// ============================================================================

export const blobApi = {
  getBlobBase64,
  getBlobAsDataUrl,
  getBlobsAsDataUrls,
  preloadBlobs,
  clearBlobCache,
  getBlobCacheStats,
};

export type BlobApiType = typeof blobApi;
