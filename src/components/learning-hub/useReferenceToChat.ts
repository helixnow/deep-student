/**
 * useReferenceToChat Hook
 *
 * 将学习资源引用到 Chat V2 对话中。
 *
 * ★ 引用模式改造（文档 24 Prompt 7）：
 * - 调用 vfs_get_resource_refs 获取引用（只有 sourceId + resourceHash）
 * - 存储时只存储引用，不存储 path/content
 * - 发送时实时获取当前路径和内容
 *
 * 类型映射：
 * | sourceType   | ResourceType   | typeId       |
 * |--------------|----------------|--------------|
 * | note         | 'note'         | 'note'       |
 * | exam         | 'exam'         | 'exam'       |
 * | textbook     | 'textbook'     | 'textbook'   |
 * | essay        | 'essay'        | 'essay'      |
 * | translation  | 'translation'  | 'translation'|
 *
 * @module components/learning-hub/useReferenceToChat
 * @see 24-LRFS统一入口模型与访达式资源管理器.md Prompt 7
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '../UnifiedNotification';
import { sessionManager } from '@/chat-v2/core/session';
import { resourceStoreApi } from '@/chat-v2/resources';
import type { ContextRef, ResourceType as StoreResourceType } from '@/chat-v2/resources/types';
import { vfsRefApi, type VfsContextRefData } from '@/chat-v2/context';
import { getErrorMessage } from '@/utils/errorUtils';
import { VfsErrorCode } from '@/shared/result';

// 类型定义
import { NOTE_TYPE_ID } from '@/chat-v2/context/definitions/note';
import { TEXTBOOK_TYPE_ID } from '@/chat-v2/context/definitions/textbook';
import { EXAM_TYPE_ID } from '@/chat-v2/context/definitions/exam';
import { ESSAY_TYPE_ID } from '@/chat-v2/context/definitions/essay';
import { TRANSLATION_TYPE_ID } from '@/chat-v2/context/definitions/translation';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 教材页面范围（引用模式下保留类型定义以维持接口兼容）
 */
export interface PageRange {
  start: number;
  end: number;
}

/**
 * 资源来源类型
 * 
 * 支持的类型：
 * - note: 笔记
 * - exam: 题目集
 * - textbook: 教材
 * - essay: 作文
 * - translation: 翻译
 */
export type SourceType = 'note' | 'exam' | 'textbook' | 'essay' | 'translation';

/**
 * 引用到对话的参数
 *
 * ★ 引用模式改造：content 字段不再必须（发送时实时获取）
 */
export interface ReferenceToChatParams {
  /** 资源来源类型 */
  sourceType: SourceType;

  /** 原始数据 ID */
  sourceId: string;

  /** 资源内容（引用模式下不再使用，保留向后兼容） */
  content?: string;

  /** 元数据 */
  metadata?: {
    title?: string;
    [key: string]: unknown;
  };

  /** 教材页面范围（仅当 sourceType='textbook' 时使用） */
  pageRange?: PageRange;
}

/**
 * 引用到对话的结果
 */
export interface ReferenceToChatResult {
  /** 是否成功 */
  success: boolean;

  /** 上下文引用（成功时返回） */
  contextRef?: ContextRef;

  /** VFS 引用数据（引用模式下返回） */
  refData?: VfsContextRefData;

  /** 错误信息 */
  error?: string;
}

/**
 * useReferenceToChat Hook 返回值
 */
export interface UseReferenceToChatReturn {
  /**
   * 将资源引用到当前对话
   *
   * ★ 引用模式流程（文档 24 Prompt 7）：
   * 1. 检查是否有活跃会话
   * 2. 调用 vfs_get_resource_refs 获取引用（只有 sourceId + resourceHash）
   * 3. 存储引用数据（不存 content）
   * 4. 添加 ContextRef 到 chatStore.pendingContextRefs
   *
   * @param params 引用参数
   * @returns 引用结果
   */
  referenceToChat: (params: ReferenceToChatParams) => Promise<ReferenceToChatResult>;

  /**
   * 检查是否可以引用到对话
   *
   * @returns 是否可以引用（有活跃会话）
   */
  canReferenceToChat: () => boolean;
}

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[useReferenceToChat]';

// ============================================================================
// 类型映射工具函数
// ============================================================================

/**
 * sourceType -> ResourceType 映射
 */
function getResourceType(sourceType: SourceType): StoreResourceType {
  switch (sourceType) {
    case 'note':
      return 'note';
    case 'exam':
      return 'exam';
    case 'textbook':
      return 'textbook';
    case 'essay':
      return 'essay';
    case 'translation':
      return 'translation';
    default:
      return 'file';
  }
}

/**
 * sourceType -> typeId 映射
 */
function getTypeId(sourceType: SourceType): string {
  switch (sourceType) {
    case 'note':
      return NOTE_TYPE_ID;
    case 'exam':
      return EXAM_TYPE_ID;
    case 'textbook':
      return TEXTBOOK_TYPE_ID;
    case 'essay':
      return ESSAY_TYPE_ID;
    case 'translation':
      return TRANSLATION_TYPE_ID;
    default:
      return 'file';
  }
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * useReferenceToChat Hook
 *
 * 提供将学习资源引用到对话的能力，集成同步服务。
 */
export function useReferenceToChat(): UseReferenceToChatReturn {
  const { t } = useTranslation(['notes', 'learningHub']);

  /**
   * 检查是否可以引用到对话
   */
  const canReferenceToChat = useCallback((): boolean => {
    const sessionIds = sessionManager.getAllSessionIds();
    return sessionIds.length > 0;
  }, []);

  /**
   * 将资源引用到当前对话
   *
   * ★ 引用模式改造（文档 24 Prompt 7）：
   * - 调用 vfs_get_resource_refs 获取引用
   * - 存储时只存储引用，不存储 content
   */
  const referenceToChat = useCallback(
    async (params: ReferenceToChatParams): Promise<ReferenceToChatResult> => {
      const { sourceType, sourceId, metadata } = params;

      console.log(LOG_PREFIX, 'referenceToChat (ref mode):', { sourceType, sourceId });

      // 1. 检查是否有活跃会话
      const sessionIds = sessionManager.getAllSessionIds();
      if (sessionIds.length === 0) {
        const errorMsg = t('notes:reference.no_active_session');
        showGlobalNotification('warning', errorMsg);
        return { success: false, error: errorMsg };
      }

      const activeSessionId = sessionIds[0];
      const store = sessionManager.get(activeSessionId);
      if (!store) {
        const errorMsg = t('notes:reference.session_not_found');
        showGlobalNotification('error', errorMsg);
        return { success: false, error: errorMsg };
      }

      try {
        // 2. ★ 调用后端获取引用（只有 sourceId + resourceHash）
        const result = await vfsRefApi.getResourceRefsV2(
          [sourceId],
          false, // includeFolderContents
          1      // maxItems
        );

        if (!result.ok) {
          let errorMsg: string;
          if (result.error.code === VfsErrorCode.NOT_FOUND) {
            errorMsg = t('notes:reference.resource_not_found');
            showGlobalNotification('warning', errorMsg);
          } else if (result.error.code === VfsErrorCode.NETWORK) {
            errorMsg = '网络错误，请重试';
            showGlobalNotification('error', errorMsg);
          } else {
            errorMsg = result.error.toUserMessage();
            showGlobalNotification('error', errorMsg);
          }
          return { success: false, error: errorMsg };
        }

        const refData = result.value;

        if (refData.refs.length === 0) {
          const errorMsg = t('notes:reference.resource_not_found');
          showGlobalNotification('warning', errorMsg);
          return { success: false, error: errorMsg };
        }

        console.log(LOG_PREFIX, 'Got resource refs:', refData);

        // 3. ★ 只存储引用，不存储 content
        const vfsRefDataForStorage: VfsContextRefData = {
          refs: refData.refs,
          totalCount: refData.totalCount,
          truncated: refData.truncated,
        };

        const resourceType = getResourceType(sourceType);
        const typeId = getTypeId(sourceType);

        const createResult = await resourceStoreApi.createOrReuse({
          type: resourceType,
          data: JSON.stringify(vfsRefDataForStorage),
          sourceId,
          metadata: {
            title: metadata?.title || '',
            ...metadata,
          },
        });

        console.log(LOG_PREFIX, 'Resource created/reused (ref mode):', createResult);

        // 4. 构建 ContextRef 并添加到 chatStore
        const contextRef: ContextRef = {
          resourceId: createResult.resourceId,
          hash: createResult.hash,
          typeId,
        };

        store.getState().addContextRef(contextRef);

        // 5. 通知用户
        const message = createResult.isNew
          ? t('notes:reference.to_chat_created_new')
          : t('notes:reference.to_chat_reused');
        showGlobalNotification('success', t('notes:reference.to_chat_success'), message);

        console.log(LOG_PREFIX, 'Reference added to chat:', contextRef);

        return {
          success: true,
          contextRef,
          refData,
        };
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        console.error(LOG_PREFIX, 'referenceToChat failed:', errorMsg);
        showGlobalNotification('error', t('notes:reference.to_chat_failed'), errorMsg);
        return { success: false, error: errorMsg };
      }
    },
    [t]
  );

  return {
    referenceToChat,
    canReferenceToChat,
  };
}

// ============================================================================
// 导出
// ============================================================================

export default useReferenceToChat;
