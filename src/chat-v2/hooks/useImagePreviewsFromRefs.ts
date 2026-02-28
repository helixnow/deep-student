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
import { getErrorMessage } from '../../utils/errorUtils';
import { VfsErrorCode } from '@/shared/result';
import { buildImageDataUrl } from '../context/imagePayload';

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
  /** 预览 URL（data URL 或 blob URL） */
  previewUrl: string;
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

/**
 * 构建预览 data URL（自动剥离混入的 OCR 片段）
 */
function buildPreviewDataUrl(data: string, mimeType: string): string | null {
  return buildImageDataUrl(data, mimeType);
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
  contextSnapshot?: ContextSnapshot
): UseImagePreviewsFromRefsResult {
  const [imagePreviews, setImagePreviews] = useState<ImagePreview[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 提取图片类型的引用
  const imageRefs = useMemo(() => {
    if (!contextSnapshot?.userRefs) return [];
    return contextSnapshot.userRefs.filter(isImageRef);
  }, [contextSnapshot]);

  // 异步加载图片内容
  useEffect(() => {
    if (imageRefs.length === 0) {
      setImagePreviews([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isMounted = true;
    const abortController = new AbortController();

    const loadImages = async () => {
      setIsLoading(true);
      setError(null);

      // 🔧 调试：开始加载图片
      window.dispatchEvent(new CustomEvent('debug:chatv2-image-preview', {
        detail: {
          stage: 'load_start',
          imageRefsCount: imageRefs.length,
          imageRefs: imageRefs.map(r => ({ resourceId: r.resourceId, typeId: r.typeId })),
        }
      }));

      const previews: ImagePreview[] = [];

      // ★ 批量收集所有 VfsResourceRef，然后一次性解析
      const allVfsRefs: Array<{ contextRef: ContextRef; vfsRef: VfsResourceRef }> = [];

      // Step 1: 从每个 ContextRef 获取 VfsContextRefData，提取 VfsResourceRef
      for (const ref of imageRefs) {
        if (abortController.signal.aborted) break;

        try {
          // 1.1 从 resources 表获取资源（res_xxx）
          const resource = await resourceStoreApi.get(ref.resourceId);

          if (!resource || !resource.data) {
            console.warn('[useImagePreviewsFromRefs] Resource not found or empty:', ref.resourceId);
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
          }
        } catch (err: unknown) {
          console.error('[useImagePreviewsFromRefs] Failed to get resource:', ref.resourceId, getErrorMessage(err));
        }
      }

      // Step 2: 批量解析 VFS 引用获取真实内容
      if (allVfsRefs.length > 0 && !abortController.signal.aborted) {
        const vfsRefsToResolve = allVfsRefs.map(({ vfsRef }) => vfsRef);
        const result = await resolveResourceRefsV2(vfsRefsToResolve);

        if (result.ok) {
          const resolvedResources = result.value;

          // 根据 sourceId 匹配
          for (const resolved of resolvedResources) {
            if (!resolved.found || !resolved.content) {
              console.warn('[useImagePreviewsFromRefs] VFS resource not found:', resolved.sourceId);
              // 设置部分资源未找到的提示（不中断整个流程）
              if (!error) {
                setError(i18next.t('chatV2:imagePreview.partialNotFound'));
              }
              continue;
            }

            // 找到对应的 contextRef
            const matched = allVfsRefs.find(({ vfsRef }) => vfsRef.sourceId === resolved.sourceId);
            if (!matched) continue;

            const mimeType = (resolved.metadata as { mimeType?: string } | undefined)?.mimeType || 'image/png';
            const previewUrl = buildPreviewDataUrl(resolved.content, mimeType);
            if (!previewUrl) {
              console.warn('[useImagePreviewsFromRefs] Skip preview due to invalid image payload:', resolved.sourceId);
              continue;
            }

            previews.push({
              id: matched.contextRef.resourceId,
              name: resolved.name,
              mimeType,
              previewUrl,
              ref: matched.contextRef,
            });
          }
        } else {
          // 解析失败
          // 🔧 P3修复：使用非空断言确保 TypeScript 正确推断错误类型
          const vfsError = result.error!;
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

          setError(errorMessage);
        }
      }

      if (isMounted) {
        // 🔧 调试：加载完成
        window.dispatchEvent(new CustomEvent('debug:chatv2-image-preview', {
          detail: {
            stage: 'load_complete',
            previewsCount: previews.length,
            previews: previews.map(p => ({
              id: p.id,
              name: p.name,
              mimeType: p.mimeType,
              previewUrlLength: p.previewUrl?.length || 0,
              previewUrlPrefix: p.previewUrl?.substring(0, 50),
            })),
          }
        }));
        
        setImagePreviews(previews);
        setIsLoading(false);
      }
    };

    loadImages();

    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [imageRefs]);

  return { imagePreviews, isLoading, error };
}

export default useImagePreviewsFromRefs;
