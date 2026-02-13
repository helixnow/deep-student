/**
 * Chat V2 - VFS 引用模式 API
 *
 * 封装 vfs_get_resource_refs 和 vfs_resolve_resource_refs 命令调用。
 * 直接调用真实后端 API，无 Mock。
 *
 * @see 24-LRFS统一入口模型与访达式资源管理器.md - Prompt 2/3
 */

import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import type { VfsContextRefData, VfsResourceRef, ResolvedResource, VfsResourceType } from './vfsRefTypes';
import { VFS_MAX_INJECTION_ITEMS } from './vfsRefTypes';
import { getErrorMessage } from '@/utils/errorUtils';
import { ok, err, toVfsError, type Result, VfsErrorCode } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';

const LOG_PREFIX = '[VfsRefApi]';

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 根据 sourceId 前缀推断类型
 */
function inferTypeFromSourceId(sourceId: string): VfsResourceType {
  if (sourceId.startsWith('note_')) return 'note';
  if (sourceId.startsWith('tb_')) return 'textbook';
  if (sourceId.startsWith('exam_')) return 'exam';
  if (sourceId.startsWith('tr_')) return 'translation';
  if (sourceId.startsWith('essay_session_') || sourceId.startsWith('essay_')) return 'essay';
  if (sourceId.startsWith('img_')) return 'image';
  // ★ 附件默认为 file，实际类型由后端根据 attachments.type 字段确定
  if (sourceId.startsWith('att_')) return 'file';
  return 'file';
}

/**
 * 生成去重键
 *
 * ★ HIGH-003: dedup_key = sourceId:resourceHash
 */
function getDedupKey(ref: VfsResourceRef): string {
  return `${ref.sourceId}:${ref.resourceHash}`;
}

/**
 * 检查资源引用是否重复
 *
 * ★ HIGH-003: 资源去重检查
 */
export function isDuplicateResourceRef(
  ref: VfsResourceRef,
  existingRefs: VfsResourceRef[]
): boolean {
  const newKey = getDedupKey(ref);
  return existingRefs.some(existing => getDedupKey(existing) === newKey);
}

/**
 * 对资源引用列表去重
 *
 * ★ HIGH-003: 基于 dedup_key = sourceId:resourceHash 去重
 * - 如果存在相同的 dedup_key，保留第一个出现的
 * - 返回去重后的引用列表
 */
export function deduplicateResourceRefs(refs: VfsResourceRef[]): VfsResourceRef[] {
  const seen = new Set<string>();
  const dedupedRefs: VfsResourceRef[] = [];

  for (const ref of refs) {
    const dedupKey = getDedupKey(ref);
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      dedupedRefs.push(ref);
    } else {
      console.log(LOG_PREFIX, 'Dedup: skipping duplicate resource', {
        sourceId: ref.sourceId,
        resourceHash: ref.resourceHash,
        name: ref.name,
      });
    }
  }

  if (dedupedRefs.length < refs.length) {
    console.log(LOG_PREFIX, `Dedup complete: ${refs.length} -> ${dedupedRefs.length}`);
  }

  return dedupedRefs;
}

/**
 * 通知资源解析失败
 *
 * ★ HIGH-004: 显示失败的资源列表和原因
 *
 * @param failedRefs 解析失败的资源引用列表
 * @param error VfsError 或 string
 */
export function notifyResolveFailed(
  failedRefs: VfsResourceRef[],
  error: VfsErrorCode | string
): void {
  if (failedRefs.length === 0) return;

  const failedNames = failedRefs.map(ref => ref.name).join('、');
  const errorMsg = typeof error === 'string' ? error : i18n.t('chatV2:vfsRef.errorCode', { code: error });

  console.error(LOG_PREFIX, 'Resource resolution failed:', {
    count: failedRefs.length,
    refs: failedRefs,
    error: errorMsg,
  });

  if (failedRefs.length === 1) {
    showGlobalNotification('error', i18n.t('chatV2:context.resolve_failed_single', { name: failedNames }) + `：${errorMsg}`);
  } else {
    showGlobalNotification('error', i18n.t('chatV2:context.resolve_failed_multiple', { count: failedRefs.length }) + `：${failedNames}。${errorMsg}`);
  }
}

/**
 * 从 ResolvedResource 列表中提取未找到的资源
 */
function extractNotFoundResources(
  resolved: ResolvedResource[],
  originalRefs: VfsResourceRef[]
): VfsResourceRef[] {
  const notFoundIds = new Set(
    resolved.filter(r => !r.found).map(r => r.sourceId)
  );

  return originalRefs.filter(ref => notFoundIds.has(ref.sourceId));
}

// ============================================================================
// 真实 API 实现
// ============================================================================

/**
 * 真实 API: 获取资源引用列表
 */
async function invokeGetResourceRefs(
  sourceIds: string[],
  includeFolderContents: boolean,
  maxItems: number
): Promise<VfsContextRefData> {
  // 后端使用 GetResourceRefsInput 结构体作为 params 参数
  return await invoke<VfsContextRefData>('vfs_get_resource_refs', {
    params: {
      sourceIds,
      includeFolderContents,
      maxItems,
    },
  });
}

/**
 * 真实 API: 解析资源引用
 */
async function invokeResolveResourceRefs(refs: VfsResourceRef[]): Promise<ResolvedResource[]> {
  return await invoke<ResolvedResource[]>('vfs_resolve_resource_refs', {
    refs,
  });
}

/**
 * 真实 API: 获取资源路径
 */
async function invokeGetResourcePath(sourceId: string): Promise<string | null> {
  return await invoke<string | null>('vfs_get_resource_path', {
    sourceId,
  });
}

/**
 * 真实 API: 更新路径缓存
 */
async function invokeUpdatePathCache(folderId: string): Promise<number> {
  return await invoke<number>('vfs_update_path_cache', {
    folderId,
  });
}

// ============================================================================
// 统一 API 接口 - Result 版本（推荐使用）
// ============================================================================

/**
 * 获取资源引用列表（注入时调用）- Result 版本
 *
 * ★ 只返回 sourceId + resourceHash，不返回 path/content
 * ★ 推荐使用此版本，可以明确区分成功和失败
 *
 * @param sourceIds 业务 ID 列表（note_xxx, tb_xxx）
 * @param includeFolderContents 如果是文件夹，是否递归获取内容
 * @param maxItems 最大返回数量（默认 50）
 * @returns Result<VfsContextRefData, VfsError>
 *
 * @example
 * ```typescript
 * const result = await getResourceRefsV2(['note_123']);
 * if (result.ok) {
 *   console.log('Refs:', result.value.refs);
 * } else {
 *   showNotification('error', result.error.toUserMessage());
 * }
 * ```
 */
export async function getResourceRefsV2(
  sourceIds: string[],
  includeFolderContents = false,
  maxItems = VFS_MAX_INJECTION_ITEMS
): Promise<Result<VfsContextRefData>> {
  try {
    console.log(LOG_PREFIX, 'getResourceRefsV2:', sourceIds);

    if (sourceIds.length === 0) {
      return err(
        toVfsError(
          new Error(i18n.t('chatV2:context.source_ids_empty')),
          i18n.t('chatV2:context.source_ids_empty'),
          { sourceIds }
        )
      );
    }

    const result = await invokeGetResourceRefs(sourceIds, includeFolderContents, maxItems);

    // ★ HIGH-003: 资源去重 - 使用 dedup_key = sourceId:resourceHash
    const dedupedRefs = deduplicateResourceRefs(result.refs);
    const dedupedResult = {
      ...result,
      refs: dedupedRefs,
      totalCount: dedupedRefs.length,
    };

    return ok(dedupedResult);
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getResourceRefsV2 failed:', getErrorMessage(error));
    const vfsError = toVfsError(error, i18n.t('chatV2:vfsRef.getRefsFailed'), { sourceIds });
    return err(vfsError);
  }
}

/**
 * 解析资源引用（发送时调用）- Result 版本
 *
 * ★ 根据 sourceId 获取当前 path 和 content
 * ★ 推荐使用此版本，可以明确区分成功和失败
 * ★ HIGH-004: 失败时自动通知用户，显示失败的资源和原因
 *
 * @param refs 资源引用列表
 * @param notifyOnError 是否在错误时通知用户（默认 true）
 * @returns Result<ResolvedResource[], VfsError>
 *
 * @example
 * ```typescript
 * const result = await resolveResourceRefsV2(refs);
 * if (result.ok) {
 *   const resources = result.value;
 *   const notFound = resources.filter(r => !r.found);
 *   if (notFound.length > 0) {
 *     console.warn('部分资源未找到:', notFound);
 *   }
 * } else {
 *   // 错误已自动通知用户
 *   console.error(result.error.toUserMessage());
 * }
 * ```
 */
export async function resolveResourceRefsV2(
  refs: VfsResourceRef[],
  notifyOnError = true
): Promise<Result<ResolvedResource[]>> {
  try {
    if (refs.length === 0) {
      return ok([]);
    }

    console.log(LOG_PREFIX, 'resolveResourceRefsV2:', refs.length, 'refs');
    const resolved = await invokeResolveResourceRefs(refs);

    // ★ HIGH-004: 检查是否有资源未找到，并通知用户
    const notFound = resolved.filter(r => !r.found);
    if (notFound.length > 0) {
      console.warn(LOG_PREFIX, `${notFound.length}/${resolved.length} resources not found:`, notFound.map(r => r.sourceId));

      if (notifyOnError) {
        const notFoundRefs = extractNotFoundResources(resolved, refs);
        notifyResolveFailed(notFoundRefs, i18n.t('chatV2:context.resource_deleted_or_moved'));
      }
    }

    // ★ 检查是否有资源解析警告（如 PDF 文本提取失败），通知用户
    if (notifyOnError) {
      const withWarnings = resolved.filter(r => r.found && r.warning);
      for (const r of withWarnings) {
        console.warn(LOG_PREFIX, `Resource resolve warning: sourceId=${r.sourceId}, warning=${r.warning}`);
        showGlobalNotification('warning', r.warning!);
      }
    }

    return ok(resolved);
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'resolveResourceRefsV2 failed:', getErrorMessage(error));
    const vfsError = toVfsError(error, i18n.t('chatV2:vfsRef.resolveRefsFailed'), {
      refCount: refs.length,
      sourceIds: refs.map(r => r.sourceId),
    });

    // ★ HIGH-004: 通知用户解析失败
    if (notifyOnError) {
      notifyResolveFailed(refs, vfsError.code);
    }

    return err(vfsError);
  }
}

/**
 * 批量解析资源引用，返回 Map 便于查找
 *
 * ★ 优化版本：一次性解析多个资源，返回 sourceId -> ResolvedResource 映射
 * ★ 适用于需要频繁查找的场景
 *
 * @param refs 资源引用列表
 * @returns sourceId -> ResolvedResource 的映射
 */
export async function resolveResourceRefsBatch(
  refs: VfsResourceRef[]
): Promise<Map<string, ResolvedResource>> {
  const result = await resolveResourceRefsV2(refs);
  const map = new Map<string, ResolvedResource>();

  if (!result.ok) {
    // 🔧 P3修复：使用非空断言确保 TypeScript 正确推断错误类型
    console.warn(LOG_PREFIX, 'resolveResourceRefsBatch failed:', result.error!.toUserMessage());
    return map;
  }

  const resolved = result.value;
  for (const resource of resolved) {
    map.set(resource.sourceId, resource);
  }

  console.log(
    LOG_PREFIX,
    'resolveResourceRefsBatch: created map with',
    map.size,
    'entries'
  );

  return map;
}

/**
 * 获取资源的当前路径 - Result 版本
 *
 * ★ 推荐使用此版本，可以明确区分未找到和错误
 *
 * @param sourceId 业务 ID
 * @returns Result<string, VfsError> - 成功返回路径，未找到或失败返回错误
 *
 * @example
 * ```typescript
 * const result = await getResourcePathV2('note_123');
 * if (result.ok) {
 *   console.log('Path:', result.value);
 * } else if (result.error.code === VfsErrorCode.NOT_FOUND) {
 *   console.warn('资源未找到');
 * } else {
 *   showNotification('error', result.error.toUserMessage());
 * }
 * ```
 */
export async function getResourcePathV2(sourceId: string): Promise<Result<string>> {
  try {
    console.log(LOG_PREFIX, 'getResourcePathV2:', sourceId);
    const path = await invokeGetResourcePath(sourceId);

    if (path === null) {
      const pathNotFoundMsg = i18n.t('chatV2:vfsRef.resourcePathNotFound', { sourceId });
      return err(
        toVfsError(
          new Error(pathNotFoundMsg),
          pathNotFoundMsg,
          { sourceId }
        )
      );
    }

    return ok(path);
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getResourcePathV2 failed:', getErrorMessage(error));
    const vfsError = toVfsError(error, i18n.t('chatV2:vfsRef.getPathFailed'), { sourceId });
    return err(vfsError);
  }
}

/**
 * 更新路径缓存（文件夹移动后调用）- Result 版本
 *
 * ★ 推荐使用此版本，可以明确区分成功和失败
 *
 * @param folderId 被移动的文件夹 ID
 * @returns Result<number, VfsError> - 成功返回更新的项数
 *
 * @example
 * ```typescript
 * const result = await updatePathCacheV2('folder_123');
 * if (result.ok) {
 *   console.log('更新了', result.value, '项缓存');
 * } else {
 *   showNotification('error', result.error.toUserMessage());
 * }
 * ```
 */
export async function updatePathCacheV2(folderId: string): Promise<Result<number>> {
  try {
    console.log(LOG_PREFIX, 'updatePathCacheV2:', folderId);
    const count = await invokeUpdatePathCache(folderId);
    return ok(count);
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'updatePathCacheV2 failed:', getErrorMessage(error));
    const vfsError = toVfsError(error, i18n.t('chatV2:vfsRef.updateCacheFailed'), { folderId });
    return err(vfsError);
  }
}

/**
 * 创建单个资源的 VfsContextRefData
 *
 * 便捷方法，用于单个资源的注入场景。
 * ★ 必须从后端获取真实 hash，禁止使用临时 hash！
 *
 * @param sourceId 业务 ID
 * @param resourceHash 资源 hash（可选，不传则从后端获取）
 * @param type 资源类型（可选，不传则由后端返回）
 * @param name 资源名称（可选，不传则由后端返回）
 */
export async function createSingleResourceRefData(
  sourceId: string,
  resourceHash?: string,
  type?: VfsResourceType,
  name?: string
): Promise<VfsContextRefData> {
  // ★ 如果已提供所有参数，直接构造（用于调用方已有真实 hash 的场景）
  if (resourceHash && type && name) {
    return {
      refs: [
        {
          sourceId,
          resourceHash,
          type,
          name,
        },
      ],
      totalCount: 1,
      truncated: false,
    };
  }

  // ★ 否则必须从后端获取真实的引用信息（包含真实 hash）
  const result = await getResourceRefsV2([sourceId], false, 1);
  if (!result.ok) {
    // 🔧 P3修复：使用非空断言确保 TypeScript 正确推断错误类型
    const error = result.error!;
    console.error(LOG_PREFIX, 'createSingleResourceRefData failed:', error.toUserMessage());
    throw new Error(error.toUserMessage());
  }

  const refData = result.value;
  if (refData.refs.length > 0) {
    return refData;
  }

  // 后端未返回有效引用，抛出错误
  console.error(LOG_PREFIX, 'createSingleResourceRefData: No resource ref found for', sourceId);
  throw new Error(i18n.t('chatV2:vfsRef.resourceNotFound', { sourceId, defaultValue: `Resource not found: ${sourceId}` }));
}

// ============================================================================
// 导出
// ============================================================================

// ============================================================================
// ResourceHash 更新 API (HIGH-005)
// ============================================================================

/**
 * 更新资源的 resourceHash
 *
 * ★ HIGH-005: 资源内容变更后同步更新 resourceHash
 * - 在 DSTU update 操作后调用
 * - 通知所有订阅者更新 hash
 *
 * @param sourceId 业务 ID (note_xxx, tb_xxx等)
 * @param newHash 新的资源 hash
 * @returns Result<void, VfsError>
 */
export async function updateResourceHashV2(
  sourceId: string,
  newHash: string
): Promise<Result<void>> {
  try {
    console.log(LOG_PREFIX, 'updateResourceHashV2:', { sourceId, newHash });

    if (!sourceId || !newHash) {
      return err(
        toVfsError(
          new Error(i18n.t('chatV2:vfsRef.sourceIdAndHashRequired')),
          i18n.t('chatV2:vfsRef.sourceIdAndHashRequired'),
          { sourceId, newHash }
        )
      );
    }

    // 调用后端更新资源 hash
    await invoke('vfs_update_resource_hash', {
      sourceId,
      newHash,
    });

    console.log(LOG_PREFIX, 'resourceHash updated:', { sourceId, newHash });
    return ok(undefined);
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'updateResourceHashV2 failed:', getErrorMessage(error));
    const vfsError = toVfsError(error, i18n.t('chatV2:vfsRef.updateHashFailed'), { sourceId, newHash });
    return err(vfsError);
  }
}

/**
 * 获取资源被引用的数量
 *
 * ★ MEDIUM-004: 删除前查询引用数，提示用户影响范围
 *
 * @param sourceId 业务 ID (note_xxx, tb_xxx等)
 * @returns Result<number, VfsError> - 引用此资源的会话数量
 */
export async function getResourceRefCountV2(
  sourceId: string
): Promise<Result<number>> {
  try {
    console.log(LOG_PREFIX, 'getResourceRefCountV2:', sourceId);

    if (!sourceId) {
      return err(
        toVfsError(
          new Error(i18n.t('chatV2:vfsRef.sourceIdRequired')),
          i18n.t('chatV2:vfsRef.sourceIdRequired'),
          { sourceId }
        )
      );
    }

    // 调用后端查询引用计数
    const count = await invoke<number>('vfs_get_resource_ref_count', {
      sourceId,
    });

    console.log(LOG_PREFIX, `Resource ${sourceId} referenced by ${count} sessions`);
    return ok(count);
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getResourceRefCountV2 failed:', getErrorMessage(error));
    const vfsError = toVfsError(error, i18n.t('chatV2:vfsRef.getRefCountFailed'), { sourceId });
    return err(vfsError);
  }
}

// ============================================================================
// 附件上传 API
// ============================================================================

/**
 * 附件上传参数
 */
export interface UploadAttachmentParams {
  name: string;
  mimeType: string;
  base64Content: string;
  type?: 'image' | 'file';
  folderId?: string;
}

/**
 * 附件上传结果
 */
export interface UploadAttachmentResult {
  /** 附件 ID（sourceId） */
  sourceId: string;
  /** 资源哈希 */
  resourceHash: string;
  /** 是否新创建 */
  isNew: boolean;
  /** 附件元数据 */
  attachment: {
    id: string;
    resourceId?: string;
    blobHash?: string;
    type: string;
    name: string;
    mimeType: string;
    size: number;
    contentHash: string;
    createdAt: string;
    updatedAt: string;
  };
  /** 处理状态（v2.1 新增：用于 PDF/图片预处理流水线） */
  processingStatus?: string;
  /** 处理进度百分比 */
  processingPercent?: number;
  /** 已就绪的模式列表 */
  readyModes?: string[];
}

/**
 * 上传附件到 VFS
 *
 * ★ 统一附件引用模式的核心 API
 * - 小文件（<1MB）存储在 resources 表
 * - 大文件存储在 blobs 表
 * - 基于内容哈希自动去重
 *
 * @param params 上传参数
 * @returns 上传结果（包含 sourceId 和 resourceHash）
 */
export async function uploadAttachment(
  params: UploadAttachmentParams
): Promise<UploadAttachmentResult> {
  console.log(LOG_PREFIX, 'uploadAttachment:', params.name, params.mimeType, 'folderId:', params.folderId);

  const result = await invoke<UploadAttachmentResult>('vfs_upload_attachment', {
    params: {
      name: params.name,
      mimeType: params.mimeType,
      base64Content: params.base64Content,
      attachmentType: params.type,  // ★ 后端字段名是 attachment_type -> camelCase 为 attachmentType
      folderId: params.folderId,
    },
  });

  console.log(
    LOG_PREFIX,
    result.isNew ? 'Uploaded new attachment:' : 'Reused existing attachment:',
    result.sourceId
  );

  return result;
}

export const vfsRefApi = {
  // Result 版本（主要 API）
  getResourceRefsV2,
  resolveResourceRefsV2,
  getResourcePathV2,
  updatePathCacheV2,
  updateResourceHashV2,
  getResourceRefCountV2,
  // 辅助函数
  resolveResourceRefsBatch,
  createSingleResourceRefData,
  uploadAttachment,
  // 去重和通知辅助函数
  isDuplicateResourceRef,
  deduplicateResourceRefs,
  notifyResolveFailed,
};

/**
 * VFS 引用 API 类型
 */
export type VfsRefApiType = typeof vfsRefApi;

export default vfsRefApi;
