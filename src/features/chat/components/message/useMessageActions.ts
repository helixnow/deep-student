/**
 * useMessageActions - 单条消息的操作行为 Hook
 *
 * 从 MessageItem.tsx 抽出的全部操作回调与瞬态状态：
 * - 复制（含多变体复制反馈）
 * - 重试（含"将删除后续消息"的内联两步确认）
 * - 编辑 / 重发（用户消息）
 * - 删除（含多变体底部行内两步确认）
 * - 继续执行 / 保存为笔记 / 导出 Markdown / 会话分支 / 打开笔记
 *
 * MessageItem 只负责布局与派生标志，行为全部经此 Hook 提供。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { fileManager } from '@/utils/fileManager';
import { logChatV2 } from '../../debug/chatV2Logger';
import type { Block, ChatStore, Message } from '../../core/types';
import { extractMessageContentFromBlocks, extractNoteTitle } from './messageItemUtils';

/** 两步删除确认的自动复原时长（与 MessageActions / MessageTouchActionBar 一致） */
const DELETE_ARM_TIMEOUT_MS = 3500;

export interface UseMessageActionsParams {
  store: StoreApi<ChatStore>;
  messageId: string;
  message: Message | undefined;
  isLocked: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** 当前显示的块（用于文本提取 / 编辑原文） */
  displayBlocks: Block[];
  /** 当前激活变体 ID（继续执行使用） */
  activeVariantId?: string;
  /** 重试所有变体（多变体） */
  retryAllVariants?: () => Promise<void>;
}

export function useMessageActions({
  store,
  messageId,
  message,
  isLocked,
  canEdit,
  canDelete,
  displayBlocks,
  activeVariantId,
  retryAllVariants,
}: UseMessageActionsParams) {
  const { t } = useTranslation('chatV2');

  // 提取消息内容文本（content 块优先；为空时回退 thinking + mcp_tool）
  const extractMessageContent = useCallback(
    (): string => extractMessageContentFromBlocks(displayBlocks),
    [displayBlocks]
  );

  // ==========================================================================
  // 复制
  // ==========================================================================

  // 复制消息内容；失败时向上抛出，让调用方不要展示"已复制"的成功对勾
  const handleCopy = useCallback(async () => {
    if (!message) return;
    const text = extractMessageContent();
    if (!text) return; // 仍为空则不做任何操作

    try {
      await copyTextToClipboard(text);
      showGlobalNotification('success', t('messageItem.actions.copySuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Copy failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.copyFailed'));
      throw error;
    }
  }, [message, extractMessageContent, t]);

  // 多变体：底部行内复制的成功反馈
  const [multiCopied, setMultiCopied] = useState(false);
  const multiCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (multiCopiedTimerRef.current) clearTimeout(multiCopiedTimerRef.current);
  }, []);

  const handleMultiVariantCopy = useCallback(async () => {
    if (multiCopied) return;
    try {
      await handleCopy();
    } catch {
      // 复制失败：错误提示由 handleCopy 内部展示，不显示成功态对勾
      return;
    }
    setMultiCopied(true);
    multiCopiedTimerRef.current = setTimeout(() => setMultiCopied(false), 2000);
  }, [multiCopied, handleCopy]);

  // ==========================================================================
  // 多变体：重试全部 / 删除整条消息（两步确认）
  // ==========================================================================

  const [isRetryingAllVariants, setIsRetryingAllVariants] = useState(false);
  const handleRetryAllVariantsInline = useCallback(async () => {
    if (!retryAllVariants || isLocked || isRetryingAllVariants) return;
    setIsRetryingAllVariants(true);
    try {
      await retryAllVariants();
    } catch (error: unknown) {
      console.error('[MessageItem] Retry all variants failed:', error);
    } finally {
      setIsRetryingAllVariants(false);
    }
  }, [retryAllVariants, isLocked, isRetryingAllVariants]);

  const [isDeletingMultiMessage, setIsDeletingMultiMessage] = useState(false);
  // P0-4: 与 MessageActions 菜单的两步删除对齐——第一次点击进入"确认删除"
  // 红色态，3.5s 未二次点击自动复原；第二次点击才真正删除
  const [multiDeleteArmed, setMultiDeleteArmed] = useState(false);
  const multiDeleteArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (multiDeleteArmTimerRef.current) clearTimeout(multiDeleteArmTimerRef.current);
  }, []);

  const disarmMultiDelete = useCallback(() => {
    if (multiDeleteArmTimerRef.current) {
      clearTimeout(multiDeleteArmTimerRef.current);
      multiDeleteArmTimerRef.current = null;
    }
    setMultiDeleteArmed(false);
  }, []);

  const handleDeleteMultiMessageInline = useCallback(async () => {
    if (!canDelete || isDeletingMultiMessage) return;
    if (!multiDeleteArmed) {
      setMultiDeleteArmed(true);
      multiDeleteArmTimerRef.current = setTimeout(() => {
        multiDeleteArmTimerRef.current = null;
        setMultiDeleteArmed(false);
      }, DELETE_ARM_TIMEOUT_MS);
      return;
    }
    disarmMultiDelete();
    setIsDeletingMultiMessage(true);
    try {
      await store.getState().deleteMessage(messageId);
      showGlobalNotification('success', t('messageItem.actions.deleteSuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Delete multi-variant message failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.deleteFailed'));
    } finally {
      setIsDeletingMultiMessage(false);
    }
  }, [canDelete, isDeletingMultiMessage, multiDeleteArmed, disarmMultiDelete, store, messageId, t]);

  // ==========================================================================
  // 重试（内联两步确认，替代 window.confirm，禁模态）
  // ==========================================================================

  // 记录待确认的"将被删除的后续消息数"；null 表示未展开确认条
  const [retryConfirmCount, setRetryConfirmCount] = useState<number | null>(null);

  // 真正执行重试（确认后 / 无后续消息时直接调用）
  const performRetry = useCallback(async () => {
    setRetryConfirmCount(null);
    try {
      await store.getState().retryMessage(messageId);
      logChatV2('message', 'ui', 'handleRetry_completed', {
        messageId,
      }, 'success', { messageId });
    } catch (error: unknown) {
      logChatV2('message', 'ui', 'handleRetry_error', {
        messageId,
        error: getErrorMessage(error),
      }, 'error', { messageId });
      console.error('[MessageItem] Retry failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.retryFailed'));
    }
  }, [messageId, store, t]);

  // 重试入口：有后续消息将被删除时先展开内联确认条，否则直接重试
  const handleRetry = useCallback(async () => {
    if (!message || isLocked) {
      logChatV2('message', 'ui', 'handleRetry_blocked', {
        messageId,
        reason: !message ? 'message=null' : 'isLocked=true',
        isLocked,
      }, 'warning', { messageId });
      return;
    }

    // 重试会删除后续消息，需用户确认（内联确认条，非阻塞）
    const currentState = store.getState();
    const msgIndex = currentState.messageOrder.indexOf(messageId);
    const subsequentCount = msgIndex >= 0 ? currentState.messageOrder.length - msgIndex - 1 : 0;

    if (subsequentCount > 0) {
      setRetryConfirmCount(subsequentCount);
      return;
    }

    await performRetry();
  }, [message, messageId, isLocked, store, performRetry]);

  const handleRetryConfirmCancel = useCallback(() => {
    logChatV2('message', 'ui', 'handleRetry_cancelled_by_user', {
      messageId,
      subsequentCount: retryConfirmCount,
    }, 'info', { messageId });
    setRetryConfirmCount(null);
  }, [messageId, retryConfirmCount]);

  // 会话进入锁定态（如另一条消息开始流式）时自动收起确认条 / 复原删除确认，避免过期确认
  useEffect(() => {
    if (isLocked) {
      setRetryConfirmCount(null);
      disarmMultiDelete();
    }
  }, [isLocked, disarmMultiDelete]);

  const [isRetryingFailure, setIsRetryingFailure] = useState(false);
  const handleRetryFromFailureBar = useCallback(async () => {
    if (isRetryingFailure || isLocked) return;
    setIsRetryingFailure(true);
    try {
      await handleRetry();
    } finally {
      setIsRetryingFailure(false);
    }
  }, [handleRetry, isLocked, isRetryingFailure]);

  // ==========================================================================
  // 重发 / 编辑（用户消息）
  // ==========================================================================

  const handleResend = useCallback(async () => {
    if (!message || isLocked) return;
    const contentBlock = displayBlocks.find((b) => b.type === 'content');
    const currentContent = contentBlock?.content || '';

    if (!currentContent.trim()) {
      showGlobalNotification('error', t('messageItem.actions.emptyContent'), t('messageItem.actions.resendFailed'));
      return;
    }

    try {
      await store.getState().editAndResend(messageId, currentContent);
    } catch (error: unknown) {
      console.error('[MessageItem] Resend failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.resendFailed'));
    }
  }, [message, messageId, isLocked, displayBlocks, store, t]);

  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [isInlineEditing, setIsInlineEditing] = useState(false);
  const [editText, setEditText] = useState('');

  // 开始内联编辑
  const handleEdit = useCallback(() => {
    logChatV2('message', 'ui', 'handleEdit_called', {
      messageId,
      canEdit,
      isSubmittingEdit,
      hasMessage: !!message,
    }, 'info', { messageId });

    if (!canEdit || !message || isSubmittingEdit) {
      logChatV2('message', 'ui', 'handleEdit_blocked', {
        messageId,
        reason: !canEdit ? 'canEdit=false' : !message ? 'message=null' : 'isSubmittingEdit=true',
        canEdit,
        isSubmittingEdit,
      }, 'warning', { messageId });
      return;
    }

    const contentBlock = displayBlocks.find((b) => b.type === 'content');
    const originalText = contentBlock?.content || '';
    setEditText(originalText);
    setIsInlineEditing(true);

    logChatV2('message', 'ui', 'handleEdit_started', {
      messageId,
      originalTextLength: originalText.length,
    }, 'success', { messageId });
  }, [canEdit, message, isSubmittingEdit, displayBlocks, messageId]);

  // 确认编辑并重发
  const handleConfirmEdit = useCallback(async () => {
    logChatV2('message', 'ui', 'handleConfirmEdit_called', {
      messageId,
      editTextLength: editText.length,
    }, 'info', { messageId });

    const contentBlock = displayBlocks.find((b) => b.type === 'content');
    const originalText = contentBlock?.content || '';

    if (!editText.trim()) {
      logChatV2('message', 'ui', 'handleConfirmEdit_empty_content', {
        messageId,
      }, 'error', { messageId });
      showGlobalNotification('error', t('messageItem.actions.emptyContent'), t('messageItem.actions.editFailed'));
      return;
    }

    setIsInlineEditing(false);
    setIsSubmittingEdit(true);

    logChatV2('message', 'ui', 'handleConfirmEdit_submitted', {
      messageId,
      newContentLength: editText.length,
      originalContentLength: originalText.length,
    }, 'info', { messageId });

    try {
      await store.getState().editAndResend(messageId, editText);
      logChatV2('message', 'ui', 'handleConfirmEdit_completed', {
        messageId,
      }, 'success', { messageId });
    } catch (error: unknown) {
      logChatV2('message', 'ui', 'handleConfirmEdit_error', {
        messageId,
        error: getErrorMessage(error),
      }, 'error', { messageId });
      console.error('[MessageItem] Edit failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.editFailed'));
      // 提交失败时恢复编辑态，避免用户已修改的内容丢失（editText 仍保留在 state 中）
      setIsInlineEditing(true);
    } finally {
      setIsSubmittingEdit(false);
    }
  }, [displayBlocks, editText, messageId, store, t]);

  // 取消内联编辑
  const handleCancelEdit = useCallback(() => {
    setIsInlineEditing(false);
    setEditText('');
  }, []);

  // ==========================================================================
  // 删除 / 继续 / 保存 / 导出 / 分支
  // ==========================================================================

  const handleDelete = useCallback(async () => {
    if (!canDelete) return;
    try {
      await store.getState().deleteMessage(messageId);
      showGlobalNotification('success', t('messageItem.actions.deleteSuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Delete failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.deleteFailed'));
    }
  }, [canDelete, messageId, store, t]);

  // 继续执行——优先调用后端 continue_message（同消息内继续），失败时 fallback 到 sendMessage
  const handleContinue = useCallback(async () => {
    if (isLocked) {
      // 使用 getState() 获取实时状态用于日志，避免将 sessionStatus/hasActiveBlock 加入依赖数组
      const s = store.getState();
      console.warn('[MessageItem] handleContinue blocked: isLocked=true', {
        sessionStatus: s.sessionStatus,
        activeBlockIds: Array.from(s.activeBlockIds).slice(0, 5),
        messageId,
      });
      return;
    }
    try {
      await store.getState().continueMessage(messageId, activeVariantId);
    } catch (error: unknown) {
      console.error('[MessageItem] Continue failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.continueFailed'));
    }
  }, [isLocked, store, messageId, activeVariantId, t]);

  // 保存为 VFS 笔记
  const handleSaveAsNote = useCallback(async () => {
    if (!message) return;
    const text = extractMessageContent();
    if (!text) {
      showGlobalNotification('error', t('messageItem.actions.noContentToExport'));
      return;
    }
    const title = extractNoteTitle(text);
    try {
      const result = await notesDstuAdapter.createNote(title, text);
      if (result.ok) {
        showGlobalNotification('success', t('messageItem.actions.saveAsNoteSuccess', { title }));
      } else {
        showGlobalNotification('error', result.error.toUserMessage(), t('messageItem.actions.saveAsNoteFailed'));
      }
    } catch (error: unknown) {
      console.error('[MessageItem] Save as note failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.saveAsNoteFailed'));
    }
  }, [message, extractMessageContent, t]);

  // 会话分支：从此消息处创建新会话
  const isBranchingRef = useRef(false);
  const handleBranch = useCallback(async () => {
    if (isBranchingRef.current || isLocked || !message) return;
    isBranchingRef.current = true;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const sessionId = store.getState().sessionId;
      if (!sessionId) throw new Error('No active session');
      const newSession = await invoke('chat_v2_branch_session', {
        sourceSessionId: sessionId,
        upToMessageId: messageId,
      });
      // 通知 ChatV2Page 插入新会话并切换
      window.dispatchEvent(new CustomEvent('CHAT_V2_BRANCH_SESSION', {
        detail: { session: newSession },
      }));
      showGlobalNotification('success', t('messageItem.actions.branchSuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Branch session failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.branchFailed'));
    } finally {
      isBranchingRef.current = false;
    }
  }, [isLocked, message, store, messageId, t]);

  // 导出为 Markdown 文件（入口：MessageActions 更多菜单）
  const handleExportMarkdown = useCallback(async () => {
    if (!message) return;
    const text = extractMessageContent();
    if (!text) {
      showGlobalNotification('error', t('messageItem.actions.noContentToExport'));
      return;
    }
    const title = extractNoteTitle(text);
    const safeFileName = title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
    try {
      const result = await fileManager.saveTextFile({
        content: text,
        title: t('messageItem.actions.exportMarkdown'),
        defaultFileName: `${safeFileName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled) return;
      showGlobalNotification('success', t('messageItem.actions.exportMarkdownSuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Export markdown failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.exportMarkdownFailed'));
    }
  }, [message, extractMessageContent, t]);

  // 打开笔记（笔记工具预览点击时触发，在右侧 DSTU 面板中打开）
  const handleOpenNote = useCallback((noteId: string) => {
    window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
      detail: { noteId, source: 'note_tool_preview' },
    }));
  }, []);

  return {
    extractMessageContent,
    // 复制
    handleCopy,
    multiCopied,
    handleMultiVariantCopy,
    // 多变体
    isRetryingAllVariants,
    handleRetryAllVariantsInline,
    isDeletingMultiMessage,
    multiDeleteArmed,
    disarmMultiDelete,
    handleDeleteMultiMessageInline,
    // 重试
    retryConfirmCount,
    performRetry,
    handleRetry,
    handleRetryConfirmCancel,
    isRetryingFailure,
    handleRetryFromFailureBar,
    // 编辑 / 重发
    handleResend,
    isSubmittingEdit,
    isInlineEditing,
    editText,
    setEditText,
    handleEdit,
    handleConfirmEdit,
    handleCancelEdit,
    // 其他
    handleDelete,
    handleContinue,
    handleSaveAsNote,
    handleBranch,
    handleExportMarkdown,
    handleOpenNote,
  };
}

export default useMessageActions;
