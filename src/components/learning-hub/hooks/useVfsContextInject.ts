/**
 * useVfsContextInject Hook
 *
 * 将 VFS 资源通过引用模式注入到 Chat V2 对话上下文中。
 *
 * ★ 核心设计原则（文档 24）：
 * - 只存储引用（sourceId + resourceHash），不存储内容
 * - 发送时实时解析获取当前路径和内容
 * - 文件移动后引用仍然有效
 *
 * @module components/learning-hub/hooks/useVfsContextInject
 * @see 24-LRFS统一入口模型与访达式资源管理器.md - Prompt 10
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { sessionManager } from '@/chat-v2/core/session';
import { resourceStoreApi } from '@/chat-v2/resources';
import { getResourceRefsV2 } from '@/chat-v2/context/vfsRefApi';
import type { VfsContextRefData, VfsResourceType } from '@/chat-v2/context/types';
import type { ContextRef } from '@/chat-v2/resources/types';
import type { AttachmentMeta } from '@/chat-v2/core/types/common';
import { getErrorMessage } from '@/utils/errorUtils';
import { VfsErrorCode } from '@/shared/result';
import { debugLog } from '@/debug-panel/debugMasterSwitch';


// ============================================================================
// 类型定义
// ============================================================================

/**
 * 注入参数
 */
export interface VfsInjectParams {
  /** 资源 ID（note_xxx, tb_xxx, tr_xxx, essay_xxx, exam_xxx） */
  sourceId: string;
  /** 资源类型 */
  sourceType: VfsResourceType;
  /** 资源名称（用于显示） */
  name: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 资源 hash（可选，如果已知） */
  resourceHash?: string;
}

/**
 * 注入结果
 */
export interface VfsInjectResult {
  success: boolean;
  contextRef?: ContextRef;
  error?: string;
}

/**
 * Hook 返回值
 */
export interface UseVfsContextInjectReturn {
  /** 将资源注入到对话上下文 */
  injectToChat: (params: VfsInjectParams) => Promise<VfsInjectResult>;
  /** 检查是否可以注入（有活跃会话） */
  canInject: () => boolean;
  /** 是否正在注入 */
  isInjecting: boolean;
}

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[useVfsContextInject]';

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * VFS 引用模式上下文注入 Hook
 *
 * 提供将 VFS 资源（笔记、教材、题目集、翻译、作文）注入到对话上下文的能力。
 * 使用引用模式，只存储 sourceId + resourceHash，不存储实际内容。
 */
export function useVfsContextInject(): UseVfsContextInjectReturn {
  const { t } = useTranslation(['learningHub', 'notes']);
  const [isInjecting, setIsInjecting] = useState(false);

  /**
   * 检查是否可以注入
   * 🔧 P1-26: 优先使用当前活跃会话，其次使用任意活跃会话
   */
  const canInject = useCallback((): boolean => {
    // 优先检查当前活跃会话
    const currentId = sessionManager.getCurrentSessionId();
    if (currentId && sessionManager.has(currentId)) {
      return true;
    }
    // 回退：检查是否有任意活跃会话
    const sessionIds = sessionManager.getAllSessionIds();
    return sessionIds.length > 0;
  }, []);

  /**
   * 将资源注入到对话上下文
   */
  const injectToChat = useCallback(
    async (params: VfsInjectParams): Promise<VfsInjectResult> => {
      const { sourceId, sourceType, name, metadata, resourceHash } = params;

      debugLog.log(LOG_PREFIX, 'injectToChat:', { sourceId, sourceType, name });

      // 1. 检查是否有活跃会话
      // 🔧 P1-26: 优先使用当前活跃会话，其次使用任意活跃会话
      let activeSessionId = sessionManager.getCurrentSessionId();
      if (!activeSessionId || !sessionManager.has(activeSessionId)) {
        // 回退：使用第一个可用会话
        const sessionIds = sessionManager.getAllSessionIds();
        if (sessionIds.length === 0) {
          const errorMsg = t('notes:reference.no_active_session');
          showGlobalNotification('warning', errorMsg);
          return { success: false, error: errorMsg };
        }
        activeSessionId = sessionIds[0];
        debugLog.log(LOG_PREFIX, 'No current session, falling back to:', activeSessionId);
      }

      const store = sessionManager.get(activeSessionId);
      if (!store) {
        const errorMsg = t('notes:reference.session_not_found');
        showGlobalNotification('error', errorMsg);
        return { success: false, error: errorMsg };
      }

      setIsInjecting(true);

      try {
        // 2. 获取资源引用（只有 sourceId + resourceHash）
        const result = await getResourceRefsV2([sourceId], false, 1);

        if (!result.ok) {
          // 根据错误类型显示不同提示
          let errorMsg = t('learningHub:context.resourceNotFound');
          const vfsError = result.error;

          if (vfsError.code === VfsErrorCode.NOT_FOUND) {
            errorMsg = `资源 ${sourceId} 未找到`;
          } else if (vfsError.code === VfsErrorCode.NETWORK) {
            errorMsg = '网络错误，无法获取资源引用';
          } else if (vfsError.code === VfsErrorCode.PERMISSION) {
            errorMsg = '权限不足，无法访问资源';
          } else {
            errorMsg = vfsError.toUserMessage();
          }

          debugLog.error(LOG_PREFIX, 'getResourceRefsV2 failed:', vfsError.code, errorMsg);
          showGlobalNotification('error', errorMsg);
          return { success: false, error: errorMsg };
        }

        const refData = result.value;

        // 如果提供了 resourceHash，覆盖后端返回的值
        if (resourceHash && refData.refs.length > 0) {
          refData.refs[0].resourceHash = resourceHash;
        }
        // 使用传入的名称和类型
        if (refData.refs.length > 0) {
          refData.refs[0].name = name;
          refData.refs[0].type = sourceType;
        }

        if (refData.refs.length === 0) {
          const errorMsg = t('learningHub:context.resourceNotFound');
          debugLog.error(LOG_PREFIX, 'No refs returned for sourceId:', sourceId);
          showGlobalNotification('error', errorMsg);
          return { success: false, error: errorMsg };
        }

        // 3. ★ 只存储引用，不存储内容
        const createResult = await resourceStoreApi.createOrReuse({
          type: sourceType as 'note' | 'textbook' | 'exam' | 'essay' | 'translation' | 'file',
          data: JSON.stringify(refData), // ★ 只存引用数据！
          sourceId,
          metadata: {
            name,
            refCount: refData.refs.length,
            truncated: refData.truncated,
            ...metadata,
          },
        });

        debugLog.log(LOG_PREFIX, 'Resource created/reused:', createResult);

        // 4. 构建 ContextRef 并添加到 Store
        const contextRef: ContextRef = {
          resourceId: createResult.resourceId,
          hash: createResult.hash,
          typeId: sourceType,
          displayName: name,
        };

        store.getState().addContextRef(contextRef);

        const vfsMimeTypes: Record<string, string> = {
          note: 'text/markdown',
          textbook: 'application/pdf',
          exam: 'application/json',
          translation: 'text/markdown',
          essay: 'text/markdown',
          image: 'image/*',
          file: 'application/octet-stream',
          mindmap: 'application/json',
          todo: 'application/json',
        };

        const attachmentMeta: AttachmentMeta = {
          id: `vfs-${sourceId}-${Date.now()}`,
          name,
          type: 'document',
          mimeType: vfsMimeTypes[sourceType] || 'application/octet-stream',
          size: 0,
          status: 'ready',
          resourceId: createResult.resourceId,
        };
        store.getState().addAttachment(attachmentMeta);

        const message = createResult.isNew
          ? t('notes:reference.to_chat_created_new')
          : t('notes:reference.to_chat_reused');
        showGlobalNotification('success', t('notes:reference.to_chat_success'), message);

        // ★ Bug2 修复：通知 InputBar 打开附件面板，让用户看到已添加的资源
        // 注意：批量注入时由调用方统一派发一次，避免 N 次事件
        window.dispatchEvent(new CustomEvent('CHAT_V2_OPEN_ATTACHMENT_PANEL'));

        debugLog.log(LOG_PREFIX, 'Context ref added:', contextRef);

        return {
          success: true,
          contextRef,
        };
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        debugLog.error(LOG_PREFIX, 'injectToChat failed:', errorMsg);
        showGlobalNotification('error', t('notes:reference.to_chat_failed'), errorMsg);
        return { success: false, error: errorMsg };
      } finally {
        setIsInjecting(false);
      }
    },
    [t]
  );

  return {
    injectToChat,
    canInject,
    isInjecting,
  };
}

export default useVfsContextInject;
