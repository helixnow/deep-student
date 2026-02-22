/**
 * Chat V2 - useFilePreviewsFromRefs Hook
 *
 * 从上下文引用中提取文件引用，并异步获取文件内容用于预览显示。
 * 
 * ★ VFS 引用模式改造（2025-12-10）
 * 新架构下，文件以引用形式存储在 `_meta.contextSnapshot.userRefs` 中：
 * 1. ContextRef.resourceId 指向 resources 表 (res_xxx)
 * 2. Resource.data 存储 VfsContextRefData JSON（只有引用，无实际内容）
 * 3. 需要通过 vfs_resolve_resource_refs 获取真实文件 base64
 *
 * @example
 * ```tsx
 * const { filePreviews, isLoading } = useFilePreviewsFromRefs(message._meta?.contextSnapshot);
 * ```
 */

import { useState, useEffect, useMemo } from 'react';
import i18next from 'i18next';
import type { ContextSnapshot, ContextRef, VfsContextRefData, VfsResourceRef } from '../context/types';
import { resourceStoreApi } from '../resources';
import { resolveResourceRefsV2 } from '../context/vfsRefApi';
import { getErrorMessage } from '../../utils/errorUtils';
import { VfsErrorCode } from '@/shared/result';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 文件预览数据
 */
export interface FilePreview {
  /** 引用 ID（resourceId） */
  id: string;
  /** 文件名称 */
  name: string;
  /** MIME 类型 */
  mimeType: string;
  /** 文件大小（字节） */
  size?: number;
  /** 文件内容（base64 或文本） */
  content: string;
  /** 是否为文本文件 */
  isText: boolean;
  /** 原始引用 */
  ref: ContextRef;
  /** VFS 资源 ID（att_xxx 等，用于在学习资源管理器中打开） */
  sourceId: string;
}

/**
 * Hook 返回值
 */
export interface UseFilePreviewsFromRefsResult {
  /** 文件预览列表 */
  filePreviews: FilePreview[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 加载错误信息 */
  error: string | null;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 检查是否为文件类型引用（非图片）
 */
function isFileRef(ref: ContextRef): boolean {
  return ref.typeId === 'file';
}

// ★ 后端 vfs_resolve_resource_refs 对 File 类型会使用 DocumentParser 解析文档
// 返回的 content 是已解析的文本内容，不是 base64！
// 所以前端不需要再解码，直接使用即可

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 从上下文引用中获取文件预览
 *
 * @param contextSnapshot 上下文快照
 * @returns 文件预览列表和加载状态
 */
export function useFilePreviewsFromRefs(
  contextSnapshot?: ContextSnapshot
): UseFilePreviewsFromRefsResult {
  const [filePreviews, setFilePreviews] = useState<FilePreview[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 提取文件类型的引用
  const fileRefs = useMemo(() => {
    if (!contextSnapshot?.userRefs) return [];
    return contextSnapshot.userRefs.filter(isFileRef);
  }, [contextSnapshot]);

  // 异步加载文件内容
  useEffect(() => {
    if (fileRefs.length === 0) {
      setFilePreviews([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isMounted = true;
    const abortController = new AbortController();

    const loadFiles = async () => {
      setIsLoading(true);
      setError(null);

      const previews: FilePreview[] = [];

      // ★ 批量收集所有 VfsResourceRef，然后一次性解析
      const allVfsRefs: Array<{ contextRef: ContextRef; vfsRef: VfsResourceRef }> = [];

      // Step 1: 从每个 ContextRef 获取 VfsContextRefData，提取 VfsResourceRef
      for (const ref of fileRefs) {
        if (abortController.signal.aborted) break;

        try {
          // 1.1 从 resources 表获取资源（res_xxx）
          const resource = await resourceStoreApi.get(ref.resourceId);

          if (!resource || !resource.data) {
            console.warn('[useFilePreviewsFromRefs] Resource not found or empty:', ref.resourceId);
            continue;
          }

          // ★ 统一使用 VFS 引用模式
          try {
            const refData = JSON.parse(resource.data) as VfsContextRefData;
            for (const vfsRef of refData.refs) {
              if (vfsRef.type === 'file') {
                allVfsRefs.push({ contextRef: ref, vfsRef });
              }
            }
          } catch (parseErr: unknown) {
            console.error('[useFilePreviewsFromRefs] Invalid VfsContextRefData format:', ref.resourceId, getErrorMessage(parseErr));
          }
        } catch (err: unknown) {
          console.error('[useFilePreviewsFromRefs] Failed to get resource:', ref.resourceId, getErrorMessage(err));
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
              console.warn('[useFilePreviewsFromRefs] VFS resource not found:', resolved.sourceId);
              // 设置部分资源未找到的提示（不中断整个流程）
              if (!error) {
                setError(i18next.t('chatV2:filePreview.partialNotFound'));
              }
              continue;
            }

            // 找到对应的 contextRef
            const matched = allVfsRefs.find(({ vfsRef }) => vfsRef.sourceId === resolved.sourceId);
            if (!matched) continue;

            const mimeType = (resolved.metadata as { mimeType?: string } | undefined)?.mimeType || 'application/octet-stream';
            const size = (resolved.metadata as { size?: number } | undefined)?.size;

            // ★ 后端 vfs_resolve_resource_refs 对 File 类型使用 DocumentParser 解析
            // 返回的 content 已经是解析后的文本内容，不是 base64！
            // 所以前端直接使用即可，isText 总是 true
            previews.push({
              id: matched.contextRef.resourceId,
              name: resolved.name,
              mimeType,
              size,
              content: resolved.content,  // 已解析的文本内容
              isText: true,  // 后端已解析为文本
              ref: matched.contextRef,
              sourceId: resolved.sourceId,  // VFS 资源 ID，用于在学习资源管理器中打开
            });
          }
        } else {
          // 解析失败
          // 🔧 P3修复：使用非空断言确保 TypeScript 正确推断错误类型
          const vfsError = result.error!;
          console.error('[useFilePreviewsFromRefs] Failed to resolve VFS refs:', vfsError);

          // 根据错误类型设置不同的错误消息
          let errorMessage = i18next.t('chatV2:filePreview.loadFailed');
          if (vfsError.code === VfsErrorCode.NOT_FOUND) {
            errorMessage = i18next.t('chatV2:filePreview.notFound');
          } else if (vfsError.code === VfsErrorCode.NETWORK) {
            errorMessage = i18next.t('chatV2:filePreview.networkError');
          } else if (vfsError.code === VfsErrorCode.PERMISSION) {
            errorMessage = i18next.t('chatV2:filePreview.permissionDenied');
          }

          setError(errorMessage);
        }
      }

      if (isMounted) {
        setFilePreviews(previews);
        setIsLoading(false);
      }
    };

    loadFiles();

    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [fileRefs]);

  return { filePreviews, isLoading, error };
}

export default useFilePreviewsFromRefs;
