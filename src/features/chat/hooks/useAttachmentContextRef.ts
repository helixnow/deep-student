/**
 * Chat V2 - 附件上下文引用管理 Hook
 *
 * ★ VFS 引用模式统一改造（2025-12-10）
 * 附件现在走统一的 VFS 引用模式，与其他学习资源（note/textbook/exam）保持一致：
 * - 使用 vfsRefApi.uploadAttachment() 上传附件到 VFS attachments 表
 * - Resource.data 存储 VfsContextRefData JSON（只存引用，不存内容）
 * - 发送时通过 vfs_resolve_resource_refs 解析获取实时内容
 *
 * 功能：
 * - 文件上传时创建 file/image 资源并添加 ContextRef
 * - 附件移除时移除 ContextRef
 *
 * @see 16-统一上下文注入系统架构设计.md 第八章 8.1 添加上下文流程
 * @see 17-统一上下文注入系统改造任务分配.md Prompt 10
 * @see 24-LRFS统一入口模型与访达式资源管理器.md - VFS 引用模式
 */

import { useCallback, useRef } from 'react';
import type { StoreApi } from 'zustand';
import type { ChatStore, AttachmentMeta } from '../core/types';
import { resourceStoreApi, type ContextRef, type ResourceType } from '../resources';
import { uploadAttachment, type VfsContextRefData, type VfsResourceType } from '../context';
import { IMAGE_TYPE_ID } from '../context/definitions/image';
import { FILE_TYPE_ID } from '../context/definitions/file';
import { getErrorMessage } from '@/utils/errorUtils';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:AttachmentContextRef]';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 附件与资源的映射关系
 */
interface AttachmentResourceMapping {
  attachmentId: string;
  resourceId: string;
  hash: string;
  typeId: string;
}

/**
 * Hook 返回值
 */
interface UseAttachmentContextRefReturn {
  /**
   * 处理文件上传，创建资源并添加上下文引用
   * @param file 上传的文件
   * @param attachmentId 附件 ID（可选，用于后续移除）
   * @returns ContextRef 或 null
   */
  handleFileUpload: (file: File, attachmentId?: string) => Promise<ContextRef | null>;

  /**
   * 通过 base64 数据创建资源（已从 data URL 中提取）
   * @param base64Data base64 编码的数据
   * @param mimeType MIME 类型
   * @param fileName 文件名
   * @param attachmentId 附件 ID
   * @returns ContextRef 或 null
   */
  handleBase64Upload: (
    base64Data: string,
    mimeType: string,
    fileName: string,
    attachmentId: string
  ) => Promise<ContextRef | null>;

  /**
   * 移除附件的上下文引用
   * @param attachmentId 附件 ID
   */
  removeAttachmentRef: (attachmentId: string) => void;

  /**
   * 清空所有附件引用
   */
  clearAllAttachmentRefs: () => void;
}

/**
 * Hook 配置选项
 */
interface UseAttachmentContextRefOptions {
  /** ChatStore 实例 */
  store: StoreApi<ChatStore> | null;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 根据 MIME 类型确定资源类型和 typeId
 *
 * ★ VFS 引用模式下，typeId 决定 formatToBlocks 的行为：
 * - image: 图片以 base64 传递给视觉模型
 * - file: 文档内容解析后以文本注入
 */
function getResourceTypeFromMime(mimeType: string): {
  resourceType: ResourceType;
  typeId: string;
  vfsType: VfsResourceType;
} {
  if (mimeType.startsWith('image/')) {
    return { resourceType: 'image', typeId: IMAGE_TYPE_ID, vfsType: 'image' };
  }
  return { resourceType: 'file', typeId: FILE_TYPE_ID, vfsType: 'file' };
}

/**
 * 读取文件为 Base64 字符串
 *
 * ★ VFS 引用模式需要 base64 格式上传
 */
async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // 移除 data URL 前缀，只保留 base64 部分
      const base64 = dataUrl.split(',')[1] || dataUrl;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 附件上下文引用管理 Hook
 *
 * 使用方式：
 * ```tsx
 * const { handleFileUpload, removeAttachmentRef } = useAttachmentContextRef({
 *   store: chatStore._store,
 * });
 *
 * // 文件上传时
 * const ref = await handleFileUpload(file, attachment.id);
 *
 * // 附件移除时
 * removeAttachmentRef(attachment.id);
 * ```
 */
export function useAttachmentContextRef(
  options: UseAttachmentContextRefOptions
): UseAttachmentContextRefReturn {
  const { store, enabled = true } = options;

  // 附件 ID -> 资源映射
  const attachmentMappingsRef = useRef<Map<string, AttachmentResourceMapping>>(new Map());

  /**
   * 处理文件上传
   *
   * ★ VFS 引用模式统一改造流程：
   * 1. 使用 vfsRefApi.uploadAttachment() 上传到 VFS attachments 表
   * 2. 返回 att_xxx sourceId 和 resourceHash
   * 3. 构造 VfsContextRefData JSON
   * 4. 使用 resourceStoreApi.createOrReuse() 存储 VfsContextRefData
   * 5. ContextRef 引用 resources 表的 resourceId
   */
  const handleFileUpload = useCallback(
    async (file: File, attachmentId?: string): Promise<ContextRef | null> => {
      if (!enabled || !store) {
        console.warn(LOG_PREFIX, 'Hook disabled or store not available');
        return null;
      }

      try {
        // 1. 读取文件为 base64
        const base64Content = await readFileAsBase64(file);

        // 2. 确定资源类型
        const { resourceType, typeId, vfsType } = getResourceTypeFromMime(file.type);

        // 3. ★ 使用 VFS uploadAttachment 上传到 attachments 表
        const uploadResult = await uploadAttachment({
          name: file.name,
          mimeType: file.type,
          base64Content,
          type: vfsType === 'image' ? 'image' : 'file',
        });

        console.log(
          LOG_PREFIX,
          uploadResult.isNew ? 'Uploaded new attachment:' : 'Reused existing attachment:',
          uploadResult.sourceId,
          'type:',
          vfsType
        );

        // 4. ★ 构造 VfsContextRefData（只存引用，不存内容）
        const refData: VfsContextRefData = {
          refs: [
            {
              sourceId: uploadResult.sourceId,  // att_xxx
              resourceHash: uploadResult.resourceHash,
              type: vfsType,
              name: file.name,
            },
          ],
          totalCount: 1,
          truncated: false,
        };

        // 5. ★ 存储 VfsContextRefData JSON 到 resources 表
        const resourceResult = await resourceStoreApi.createOrReuse({
          type: resourceType,
          data: JSON.stringify(refData),  // ★ 存储 JSON，不是原始内容！
          sourceId: uploadResult.sourceId,  // 关联 att_xxx
          metadata: {
            name: file.name,
            mimeType: file.type,
            size: file.size,
            // ★ 标记为 VFS 引用模式
            vfsRefMode: true,
          },
        });

        console.log(
          LOG_PREFIX,
          'Created context resource:',
          resourceResult.resourceId,
          'for attachment:',
          uploadResult.sourceId
        );

        // 6. 构建上下文引用
        const contextRef: ContextRef = {
          resourceId: resourceResult.resourceId,
          hash: resourceResult.hash,
          typeId,
        };

        // 7. 添加到 Store
        const storeState = store.getState();
        storeState.addContextRef(contextRef);
        console.log(LOG_PREFIX, 'Added context ref:', resourceResult.resourceId);

        // 8. 保存映射关系
        if (attachmentId) {
          attachmentMappingsRef.current.set(attachmentId, {
            attachmentId,
            resourceId: resourceResult.resourceId,
            hash: resourceResult.hash,
            typeId,
          });
        }

        return contextRef;
      } catch (error: unknown) {
        console.error(LOG_PREFIX, 'Failed to upload file:', getErrorMessage(error));
        return null;
      }
    },
    [enabled, store]
  );

  /**
   * 通过 base64 数据创建资源
   *
   * ★ VFS 引用模式统一改造
   */
  const handleBase64Upload = useCallback(
    async (
      base64Data: string,
      mimeType: string,
      fileName: string,
      attachmentId: string
    ): Promise<ContextRef | null> => {
      if (!enabled || !store) {
        console.warn(LOG_PREFIX, 'Hook disabled or store not available');
        return null;
      }

      try {
        // 1. 确定资源类型
        const { resourceType, typeId, vfsType } = getResourceTypeFromMime(mimeType);

        // 2. ★ 使用 VFS uploadAttachment 上传到 attachments 表
        const uploadResult = await uploadAttachment({
          name: fileName,
          mimeType,
          base64Content: base64Data,
          type: vfsType === 'image' ? 'image' : 'file',
        });

        console.log(
          LOG_PREFIX,
          uploadResult.isNew ? 'Uploaded new attachment:' : 'Reused existing attachment:',
          uploadResult.sourceId,
          'type:',
          vfsType
        );

        // 3. ★ 构造 VfsContextRefData（只存引用，不存内容）
        const refData: VfsContextRefData = {
          refs: [
            {
              sourceId: uploadResult.sourceId,  // att_xxx
              resourceHash: uploadResult.resourceHash,
              type: vfsType,
              name: fileName,
            },
          ],
          totalCount: 1,
          truncated: false,
        };

        // 4. ★ 存储 VfsContextRefData JSON 到 resources 表
        const resourceResult = await resourceStoreApi.createOrReuse({
          type: resourceType,
          data: JSON.stringify(refData),  // ★ 存储 JSON，不是原始内容！
          sourceId: uploadResult.sourceId,  // 关联 att_xxx
          metadata: {
            name: fileName,
            mimeType,
            size: uploadResult.attachment.size,
            // ★ 标记为 VFS 引用模式
            vfsRefMode: true,
          },
        });

        console.log(
          LOG_PREFIX,
          'Created context resource:',
          resourceResult.resourceId,
          'for attachment:',
          uploadResult.sourceId
        );

        // 5. 构建上下文引用
        const contextRef: ContextRef = {
          resourceId: resourceResult.resourceId,
          hash: resourceResult.hash,
          typeId,
        };

        // 6. 添加到 Store
        const storeState = store.getState();
        storeState.addContextRef(contextRef);
        console.log(LOG_PREFIX, 'Added context ref:', resourceResult.resourceId);

        // 7. 保存映射关系
        attachmentMappingsRef.current.set(attachmentId, {
          attachmentId,
          resourceId: resourceResult.resourceId,
          hash: resourceResult.hash,
          typeId,
        });

        return contextRef;
      } catch (error: unknown) {
        console.error(LOG_PREFIX, 'Failed to upload base64 data:', getErrorMessage(error));
        return null;
      }
    },
    [enabled, store]
  );

  /**
   * 移除附件的上下文引用
   */
  const removeAttachmentRef = useCallback(
    (attachmentId: string) => {
      if (!enabled || !store) {
        return;
      }

      const mapping = attachmentMappingsRef.current.get(attachmentId);
      if (mapping) {
        const storeState = store.getState();
        storeState.removeContextRef(mapping.resourceId);
        attachmentMappingsRef.current.delete(attachmentId);
        console.log(LOG_PREFIX, 'Removed context ref:', mapping.resourceId);
      }
    },
    [enabled, store]
  );

  /**
   * 清空所有附件引用
   */
  const clearAllAttachmentRefs = useCallback(() => {
    if (!enabled || !store) {
      return;
    }

    const storeState = store.getState();
    for (const mapping of attachmentMappingsRef.current.values()) {
      storeState.removeContextRef(mapping.resourceId);
    }
    attachmentMappingsRef.current.clear();
    console.log(LOG_PREFIX, 'Cleared all attachment refs');
  }, [enabled, store]);

  return {
    handleFileUpload,
    handleBase64Upload,
    removeAttachmentRef,
    clearAllAttachmentRefs,
  };
}

// ============================================================================
// 导出类型
// ============================================================================

export type { UseAttachmentContextRefOptions, UseAttachmentContextRefReturn, AttachmentResourceMapping };
