import type React from 'react';
import { useCallback } from 'react';
import type { DstuNode } from '@/dstu';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { pLimit } from '@/utils/concurrency';
import type { VfsResourceType } from '@/features/chat/context/types';
import type { ContextMenuTarget } from '../components/LearningHubContextMenu';
import type { UseVfsContextInjectReturn } from '../hooks';
import type { LearningHubSidebarProps } from '../types';
import type { SidebarT } from './sidebarConstants';

type ReferenceToChat = (
  target: ContextMenuTarget,
  options?: { openAttachmentPanel?: boolean },
) => Promise<boolean>;

/** 右键「引用到对话」→ injectToChat */
export function useSidebarReferenceToChat({
  canInject,
  injectToChat,
  onReferenceToChat,
  t,
}: {
  canInject: UseVfsContextInjectReturn['canInject'];
  injectToChat: UseVfsContextInjectReturn['injectToChat'];
  onReferenceToChat: LearningHubSidebarProps['onReferenceToChat'];
  t: SidebarT;
}) {
  // ★ 右键「引用到对话」→ injectToChat（对齐批量注入契约）
  const handleReferenceToChat = useCallback(async (
    target: ContextMenuTarget,
    options?: { openAttachmentPanel?: boolean },
  ): Promise<boolean> => {
    if (!canInject()) {
      showGlobalNotification('warning', t('finder.multiSelect.noChatSession'));
      return false;
    }

    const typeMap: Record<string, VfsResourceType> = {
      note: 'note',
      textbook: 'textbook',
      exam: 'exam',
      translation: 'translation',
      essay: 'essay',
      image: 'image',
      file: 'file',
      mindmap: 'mindmap',
    };

    let sourceId: string | null = null;
    let sourceType: VfsResourceType | null = null;
    let name = '';

    if (target.type === 'resource') {
      const resource = target.resource;
      sourceType = typeMap[resource.type] ?? null;
      sourceId = resource.id;
      name = resource.title;
    } else if (target.type === 'folderItem') {
      const item = target.item;
      sourceType = typeMap[item.itemType] ?? null;
      sourceId = item.itemId || item.id;
      name = item.itemId || item.id;
    } else {
      return false;
    }

    if (!sourceId || !sourceType) {
      showGlobalNotification('warning', t('error.unsupportedResourceType', { type: 'unknown' }));
      return false;
    }

    const result = await injectToChat({
      sourceId,
      sourceType,
      name,
      metadata: { title: name },
      openAttachmentPanel: options?.openAttachmentPanel,
    });
    if (result.success && result.contextRef && onReferenceToChat) {
      onReferenceToChat(result.contextRef);
    }
    return result.success;
  }, [canInject, injectToChat, onReferenceToChat, t]);

  return handleReferenceToChat;
}

/** 资料 → 闪卡一步入口 */
export function useMakeCardsAction({
  handleReferenceToChat,
  t,
}: {
  handleReferenceToChat: ReferenceToChat;
  t: SidebarT;
}) {
  // 资料 → 闪卡一步入口：新开一个对话（不混进正在进行的话题）→ 引用这份资料 →
  // 切到聊天并预填制卡指令（不自动发送，便于改数量/模板）。
  const handleMakeCards = useCallback(async (target: ContextMenuTarget) => {
    // 动态导入：避免学习资源模块静态依赖整条聊天会话/适配器链
    const { sessionManager } = await import('@/features/chat/core/session/sessionManager');
    const previousSessionId = sessionManager.getCurrentSessionId();
    const newSessionReady = new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => { unsubscribe(); resolve(false); }, 4000);
      const unsubscribe = sessionManager.subscribe((event) => {
        if (event.type === 'current-session-changed' && event.sessionId
          && event.sessionId !== previousSessionId && sessionManager.has(event.sessionId)) {
          window.clearTimeout(timer);
          unsubscribe();
          resolve(true);
        }
      });
    });
    dispatchAppEvent(APP_EVENTS.CHAT_NEW_SESSION);
    // 新会话没起来（极少见）就退回当前会话，不让入口失效
    await newSessionReady;
    // 输入框里的引用条已经显示这份资料，不再弹附件面板（会盖住空态标题、与引用条重复）
    const ok = await handleReferenceToChat(target, { openAttachmentPanel: false });
    if (!ok) return;
    const name = target.type === 'resource'
      ? target.resource.title
      : target.type === 'folderItem' ? (target.item.itemId || target.item.id) : '';
    dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
      content: t('contextMenu.makeCardsPrompt', { name }),
    });
  }, [handleReferenceToChat, t]);

  return handleMakeCards;
}

export interface BatchAddToChatContext {
  selectedIds: Set<string>;
  canAddToChatInCurrentView: boolean;
  canInject: UseVfsContextInjectReturn['canInject'];
  t: SidebarT;
  setIsBatchProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  items: DstuNode[];
  injectToChat: UseVfsContextInjectReturn['injectToChat'];
  isMountedRef: React.MutableRefObject<boolean>;
  clearSelection: () => void;
  setSelectedIds: (ids: Set<string>) => void;
}

// ★ 批量添加到对话（将选中的文件引用发送到 Chat V2 附件区域）
export async function batchAddSelectionToChat({
  selectedIds,
  canAddToChatInCurrentView,
  canInject,
  t,
  setIsBatchProcessing,
  items,
  injectToChat,
  isMountedRef,
  clearSelection,
  setSelectedIds,
}: BatchAddToChatContext): Promise<void> {
  if (selectedIds.size === 0 || !canAddToChatInCurrentView) return;
  if (!canInject()) {
    showGlobalNotification('warning', t('finder.multiSelect.noChatSession'));
    return;
  }

  setIsBatchProcessing(true);

  try {
    const idsArray = Array.from(selectedIds);
    const limit = pLimit(3);

    const injectResults = await Promise.all(idsArray.map((id) =>
      limit(async () => {
        const item = items.find(i => i.id === id);
        if (!item) {
          return { id, ok: false, error: t('error.itemNotFound') };
        }

        // 文件夹不支持添加到对话
        if (item.type === 'folder') {
          return { id, ok: false, error: t('error.folderCannotAddToChat') };
        }

        // 映射 DstuNodeType 到 VfsResourceType
        const typeMap: Record<string, VfsResourceType> = {
          note: 'note',
          textbook: 'textbook',
          exam: 'exam',
          translation: 'translation',
          essay: 'essay',
          image: 'image',
          file: 'file',
          mindmap: 'mindmap',
        };

        const sourceType = typeMap[item.type];
        if (!sourceType) {
          return { id, ok: false, error: t('error.unsupportedResourceType', { type: item.type }) };
        }

        const result = await injectToChat({
          sourceId: item.sourceId || item.id,
          sourceType,
          name: item.name,
          metadata: { title: item.name },
          resourceHash: item.resourceHash,
          openAttachmentPanel: false,
        });

        return { id, ok: result.success, error: result.error };
      })
    ));

    if (!isMountedRef.current) return;

    const failedResults = injectResults.filter(r => !r.ok);
    const succeeded = injectResults.length - failedResults.length;
    const failed = failedResults.length;

    if (succeeded > 0) {
      window.dispatchEvent(new CustomEvent('CHAT_V2_OPEN_ATTACHMENT_PANEL'));
    }

    if (failed === 0) {
      showGlobalNotification('success', t('finder.multiSelect.addToChatSuccess', { count: succeeded }));
      clearSelection();
    } else if (succeeded > 0) {
      showGlobalNotification('warning',
        t('finder.multiSelect.addToChatPartial', { succeeded, failed })
      );
      // 保留失败项的选择状态
      const failedIds = failedResults.map(r => r.id);
      setSelectedIds(new Set(failedIds));
    } else {
      showGlobalNotification('error', t('finder.multiSelect.addToChatFailed'));
    }
  } catch (err) {
    debugLog.error('[LearningHub] 批量添加到对话失败:', err);
    showGlobalNotification('error', t('finder.multiSelect.addToChatFailed'));
  } finally {
    if (isMountedRef.current) {
      setIsBatchProcessing(false);
    }
  }
}
