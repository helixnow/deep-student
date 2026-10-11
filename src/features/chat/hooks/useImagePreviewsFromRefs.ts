/**
 * Chat V2 - useImagePreviewsFromRefs Hook
 *
 * 从上下文引用中提取图片引用，并异步获取图片内容用于预览显示。
 *
 * ★ VFS 引用模式改造（2025-12-10）
 * 新架构下，图片以引用形式存储在 `_meta.contextSnapshot.userRefs` 中：
 * 1. ContextRef.resourceId 指向 resources 表 (res_xxx)
 * 2. Resource.data 存储 VfsContextRefData JSON（只有引用，无实际内容）
 * 3. 需要通过 vfs_resolve_resource_refs 获取真实图片 base64
 * 4. base64 只在加载时过一手：转成原图 blob URL + 长边 256px 缩略图（列表格子只解码
 *    缩略图），按 (resourceId, hash) 跨消息共享缓存（见 imagePreviewAssets.ts）
 *
 * @example
 * ```tsx
 * const { imagePreviews, isLoading } = useImagePreviewsFromRefs(message._meta?.contextSnapshot);
 * ```
 */

import { useState, useEffect, useMemo } from 'react';
import i18next from 'i18next';
import type { ContextSnapshot, ContextRef, VfsContextRefData, VfsResourceRef } from '../context/types';
import { resourceStoreApi } from '../resources';
import { resolveResourceRefsV2 } from '../context/vfsRefApi';
import { getErrorMessage } from '@/utils/errorUtils';
import { VfsErrorCode } from '@/shared/result';
import {
  createImagePreviewAsset,
  revokeImagePreviewAsset,
  type ImagePreviewAsset,
} from '../context/imagePreviewAssets';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 图片预览数据
 */
export interface ImagePreview {
  /** 引用 ID（resourceId） */
  id: string;
  /** 图片名称 */
  name: string;
  /** MIME 类型 */
  mimeType: string;
  /** 原图 URL（blob URL；全屏查看器 / 下载用，不直接上屏） */
  previewUrl: string;
  /** 缩略图 URL（blob URL；64px 格子用，无法缩略时等于 previewUrl） */
  thumbnailUrl: string;
  /** 原始引用 */
  ref: ContextRef;
}

/**
 * Hook 返回值
 */
export interface UseImagePreviewsFromRefsResult {
  /** 图片预览列表 */
  imagePreviews: ImagePreview[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 加载错误信息 */
  error: string | null;
  /** References intentionally deferred until the user expands the attachment row. */
  unloadedImageCount: number;
}

// ============================================================================
// 跨消息共享的预览缓存
// ============================================================================
//
// 同一张图常被多条消息引用（编辑重发 / 分支 / 重试），虚拟滚动还会让行反复
// 卸载重挂。旧实现的缓存是每个 hook 实例私有的 Map，每次挂载都重新走一遍
// IPC 拿整张原图 base64。这里按 (resourceId, hash) 共享：一张图在应用生命
// 周期内只解析、解码、缩略一次。
// 引用计数保护正在显示的条目；无人引用的条目超过上限时按插入序淘汰并释放 blob URL。

interface ResolvedRefPreview {
  name: string;
  asset: ImagePreviewAsset;
}

interface RefLoadResult {
  previews: ResolvedRefPreview[];
  error: string | null;
  /** 资源缺失 / 解析失败：无人引用时丢弃，下次挂载重试 */
  failed: boolean;
}

interface CacheEntry {
  promise: Promise<RefLoadResult>;
  result?: RefLoadResult;
  refCount: number;
}

/** 无人引用的已完成条目最多保留数（超出按插入序淘汰） */
const MAX_IDLE_PREVIEW_ENTRIES = 48;

const previewCache = new Map<string, CacheEntry>();

function refCacheKey(ref: ContextRef): string {
  return `${ref.resourceId}\u0000${ref.hash}`;
}

function disposeEntry(key: string, entry: CacheEntry): void {
  if (previewCache.get(key) === entry) previewCache.delete(key);
  entry.result?.previews.forEach(({ asset }) => revokeImagePreviewAsset(asset));
}

function evictIdleEntries(): void {
  let idle = 0;
  previewCache.forEach((entry) => {
    if (entry.refCount === 0 && entry.result) idle += 1;
  });
  for (const [key, entry] of Array.from(previewCache)) {
    if (idle <= MAX_IDLE_PREVIEW_ENTRIES) break;
    if (entry.refCount === 0 && entry.result) {
      disposeEntry(key, entry);
      idle -= 1;
    }
  }
}

function emptyResults(refs: ContextRef[], error: string | null): Map<ContextRef, RefLoadResult> {
  return new Map(refs.map((ref) => [ref, { previews: [], error, failed: true }]));
}

/**
 * 批量加载一组引用：resources 表取 VfsContextRefData → 一次 IPC 解析全部
 * VFS 图片引用 → 每张图转成 blob URL + 缩略图。
 */
async function loadRefPreviews(refs: ContextRef[]): Promise<Map<ContextRef, RefLoadResult>> {
  const results = new Map<ContextRef, RefLoadResult>();
  for (const ref of refs) results.set(ref, { previews: [], error: null, failed: false });

  // ★ 批量收集所有 VfsResourceRef，然后一次性解析
  const allVfsRefs: Array<{ contextRef: ContextRef; vfsRef: VfsResourceRef }> = [];

  // Step 1: 从每个 ContextRef 获取 VfsContextRefData，提取 VfsResourceRef
  for (const ref of refs) {
    const result = results.get(ref)!;
    try {
      // 1.1 从 resources 表获取资源（res_xxx）
      const resource = await resourceStoreApi.get(ref.resourceId);

      if (!resource || !resource.data) {
        console.warn('[useImagePreviewsFromRefs] Resource not found or empty:', ref.resourceId);
        result.failed = true;
        continue;
      }

      // ★ 统一使用 VFS 引用模式，禁止回退旧模式
      // Resource.data 存储的是 VfsContextRefData JSON
      try {
        const refData = JSON.parse(resource.data) as VfsContextRefData;
        for (const vfsRef of refData.refs) {
          if (vfsRef.type === 'image') {
            // 预览场景只需要原图，强制 image-only 注入模式，避免拿到 OCR 混合内容
            allVfsRefs.push({
              contextRef: ref,
              vfsRef: {
                ...vfsRef,
                injectModes: { image: ['image'] },
              },
            });
          }
        }
      } catch (parseErr: unknown) {
        // JSON 解析失败，说明数据格式不正确
        console.error('[useImagePreviewsFromRefs] Invalid VfsContextRefData format:', ref.resourceId, getErrorMessage(parseErr));
        result.failed = true;
      }
    } catch (err: unknown) {
      console.error('[useImagePreviewsFromRefs] Failed to get resource:', ref.resourceId, getErrorMessage(err));
      result.failed = true;
    }
  }

  if (allVfsRefs.length === 0) return results;

  // Step 2: 批量解析 VFS 引用获取真实内容
  const resolveResult = await resolveResourceRefsV2(allVfsRefs.map(({ vfsRef }) => vfsRef));

  if (!resolveResult.ok) {
    // 🔧 P3修复：使用非空断言确保 TypeScript 正确推断错误类型
    const vfsError = resolveResult.error!;
    console.error('[useImagePreviewsFromRefs] Failed to resolve VFS refs:', vfsError);

    // 根据错误类型设置不同的错误消息
    let errorMessage = i18next.t('chatV2:imagePreview.loadFailed');
    if (vfsError.code === VfsErrorCode.NOT_FOUND) {
      errorMessage = i18next.t('chatV2:imagePreview.notFound');
    } else if (vfsError.code === VfsErrorCode.NETWORK) {
      errorMessage = i18next.t('chatV2:imagePreview.networkError');
    } else if (vfsError.code === VfsErrorCode.PERMISSION) {
      errorMessage = i18next.t('chatV2:imagePreview.permissionDenied');
    }
    for (const { contextRef } of allVfsRefs) {
      const result = results.get(contextRef)!;
      result.error = errorMessage;
      result.failed = true;
    }
    return results;
  }

  // 根据 sourceId 匹配（同一 sourceId 可能被多个引用共用，逐一分配）
  for (const resolved of resolveResult.value) {
    const owners = Array.from(new Set(
      allVfsRefs
        .filter(({ vfsRef }) => vfsRef.sourceId === resolved.sourceId)
        .map(({ contextRef }) => contextRef),
    ));
    if (owners.length === 0) continue;

    if (!resolved.found || !resolved.content) {
      console.warn('[useImagePreviewsFromRefs] VFS resource not found:', resolved.sourceId);
      // 记录部分资源未找到的提示（不中断整个流程）
      for (const owner of owners) {
        const result = results.get(owner)!;
        result.error ??= i18next.t('chatV2:imagePreview.partialNotFound');
        result.failed = true;
      }
      continue;
    }

    const mimeType = (resolved.metadata as { mimeType?: string } | undefined)?.mimeType || 'image/png';
    const asset = await createImagePreviewAsset(resolved.content, mimeType);
    if (!asset) {
      console.warn('[useImagePreviewsFromRefs] Skip preview due to invalid image payload:', resolved.sourceId);
      continue;
    }
    for (const owner of owners) {
      results.get(owner)!.previews.push({ name: resolved.name, asset });
    }
  }

  return results;
}

/**
 * 取得（必要时发起加载）一组引用的共享缓存条目，并为每个引用加一次引用计数。
 * 未缓存的引用合并为一次批量加载。
 */
function acquirePreviewEntries(refs: ContextRef[]): CacheEntry[] {
  const missing: ContextRef[] = [];
  const missingKeys = new Set<string>();
  for (const ref of refs) {
    const key = refCacheKey(ref);
    if (!previewCache.has(key) && !missingKeys.has(key)) {
      missingKeys.add(key);
      missing.push(ref);
    }
  }

  if (missing.length > 0) {
    const batch = loadRefPreviews(missing).catch((err: unknown) => {
      console.error('[useImagePreviewsFromRefs] Failed to load previews:', getErrorMessage(err));
      return emptyResults(missing, i18next.t('chatV2:imagePreview.loadFailed'));
    });
    for (const ref of missing) {
      const key = refCacheKey(ref);
      const entry: CacheEntry = {
        refCount: 0,
        promise: batch.then((byRef) => {
          const result = byRef.get(ref) ?? { previews: [], error: null, failed: true };
          entry.result = result;
          // 加载期间所有使用者都已离开：失败条目直接丢弃，成功条目参与淘汰
          if (entry.refCount === 0) {
            if (result.failed) disposeEntry(key, entry);
            else evictIdleEntries();
          }
          return result;
        }),
      };
      previewCache.set(key, entry);
    }
  }

  return refs.map((ref) => {
    const entry = previewCache.get(refCacheKey(ref))!;
    entry.refCount += 1;
    return entry;
  });
}

function releasePreviewEntries(entries: Array<[string, CacheEntry]>): void {
  for (const [, entry] of entries) {
    entry.refCount = Math.max(0, entry.refCount - 1);
  }
  // 延后结算：同一次提交里 effect 先清理再重跑（如展开更多），条目会被立即重新
  // 引用；等这一轮结束再判断，避免把刚失败的引用丢掉又重复请求一遍
  setTimeout(() => {
    for (const [key, entry] of entries) {
      if (entry.refCount === 0 && entry.result?.failed) disposeEntry(key, entry);
    }
    evictIdleEntries();
  }, 0);
}

/** 测试用：清空共享缓存（释放全部 blob URL） */
export function __resetImagePreviewCacheForTests(): void {
  for (const [key, entry] of Array.from(previewCache)) disposeEntry(key, entry);
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 检查是否为图片类型引用
 */
function isImageRef(ref: ContextRef): boolean {
  return ref.typeId === 'image';
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 从上下文引用中获取图片预览
 *
 * @param contextSnapshot 上下文快照
 * @returns 图片预览列表和加载状态
 */
export function useImagePreviewsFromRefs(
  contextSnapshot?: ContextSnapshot,
  maxCount = Infinity,
): UseImagePreviewsFromRefsResult {
  const [imagePreviews, setImagePreviews] = useState<ImagePreview[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedRefs, setLoadedRefs] = useState<ContextRef[] | null>(null);

  // 提取图片类型的引用
  const imageRefs = useMemo(() => {
    if (!contextSnapshot?.userRefs) return [];
    return contextSnapshot.userRefs.filter(isImageRef);
  }, [contextSnapshot?.userRefs]);
  const requestedRefs = useMemo(() => imageRefs.slice(0, maxCount), [imageRefs, maxCount]);
  // 展开同一快照时复用已构建的预览对象（保持引用稳定）；新的引用列表换新 Map，
  // 编辑/删除过的附件不会沿用旧对象。底层图片数据由共享缓存提供。
  const previewsByRef = useMemo(() => new Map<ContextRef, ImagePreview[]>(), [imageRefs]);

  // 异步加载图片内容
  useEffect(() => {
    if (requestedRefs.length === 0) {
      setImagePreviews([]);
      setIsLoading(false);
      setError(null);
      setLoadedRefs(requestedRefs);
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    // 🔧 调试：开始加载图片（只统计共享缓存未命中的引用）
    const pendingRefs = requestedRefs.filter((ref) => !previewCache.has(refCacheKey(ref)));
    window.dispatchEvent(new CustomEvent('debug:chatv2-image-preview', {
      detail: {
        stage: 'load_start',
        imageRefsCount: pendingRefs.length,
        imageRefs: pendingRefs.map(r => ({ resourceId: r.resourceId, typeId: r.typeId })),
      }
    }));

    const entries = acquirePreviewEntries(requestedRefs);
    const held = requestedRefs.map((ref, index) => [refCacheKey(ref), entries[index]] as [string, CacheEntry]);

    void Promise.all(entries.map((entry) => entry.promise)).then((results) => {
      if (!isMounted) return;
      let partialError: string | null = null;
      const requestedPreviews = requestedRefs.flatMap((ref, index) => {
        const result = results[index];
        partialError ??= result.error;
        let previews = previewsByRef.get(ref);
        if (!previews) {
          previews = result.previews.map(({ name, asset }) => ({
            id: ref.resourceId,
            name,
            mimeType: asset.mimeType,
            previewUrl: asset.fullUrl,
            thumbnailUrl: asset.thumbnailUrl,
            ref,
          }));
          previewsByRef.set(ref, previews);
        }
        return previews;
      });

      // 🔧 调试：加载完成
      window.dispatchEvent(new CustomEvent('debug:chatv2-image-preview', {
        detail: {
          stage: 'load_complete',
          previewsCount: requestedPreviews.length,
          previews: requestedPreviews.map(p => ({
            id: p.id,
            name: p.name,
            mimeType: p.mimeType,
            previewUrlLength: p.previewUrl?.length || 0,
            previewUrlPrefix: p.previewUrl?.substring(0, 50),
          })),
        }
      }));

      setImagePreviews(requestedPreviews);
      setError(partialError);
      setIsLoading(false);
      setLoadedRefs(requestedRefs);
    });

    return () => {
      isMounted = false;
      releasePreviewEntries(held);
    };
  }, [requestedRefs, previewsByRef]);

  return {
    imagePreviews,
    isLoading: requestedRefs.length > 0 && (isLoading || loadedRefs !== requestedRefs),
    error,
    unloadedImageCount: imageRefs.length - requestedRefs.length,
  };
}

export default useImagePreviewsFromRefs;
