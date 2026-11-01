import type React from 'react';
import { dstu, folderApi, type DstuNode } from '@/dstu';
import { reportError } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { finderUndoStack } from '../utils/finderUndoStack';
import type { InlineEditState } from '../stores/finderStore';
import type { LearningHubSidebarProps } from '../types';
import {
  PENDING_FOLDER_ID_PREFIX,
  isPendingFolderId,
  type PendingFolderDraft,
  type SidebarT,
} from './sidebarConstants';

export interface BeginPendingFolderDraftContext {
  ensureCreatableView: () => boolean;
  isMountedRef: React.MutableRefObject<boolean>;
  cancelInlineEdit: () => void;
  clearSelection: () => void;
  pendingFolderSequenceRef: React.MutableRefObject<number>;
  currentCreatableFolderId: string | null;
  pendingFolderDraftRef: React.MutableRefObject<PendingFolderDraft | null>;
  setPendingFolderDraft: React.Dispatch<React.SetStateAction<PendingFolderDraft | null>>;
  startInlineEdit: (id: string, type: 'folder' | 'resource', name: string) => void;
}

/** 新文件夹只作为前端草稿显示；用户提交非空名称后才写入后端。 */
export function beginPendingFolderDraft({
  ensureCreatableView,
  isMountedRef,
  cancelInlineEdit,
  clearSelection,
  pendingFolderSequenceRef,
  currentCreatableFolderId,
  pendingFolderDraftRef,
  setPendingFolderDraft,
  startInlineEdit,
}: BeginPendingFolderDraftContext): void {
  if (!ensureCreatableView()) return;
  const beginDraft = () => {
    if (!isMountedRef.current) return;
    cancelInlineEdit();
    clearSelection();
    const now = Date.now();
    const pendingId = `${PENDING_FOLDER_ID_PREFIX}${++pendingFolderSequenceRef.current}`;
    const draft: PendingFolderDraft = {
      node: {
        id: pendingId,
        sourceId: pendingId,
        path: '',
        name: '',
        type: 'folder',
        createdAt: now,
        updatedAt: now,
        childCount: 0,
      },
      parentFolderId: currentCreatableFolderId,
    };
    pendingFolderDraftRef.current = draft;
    setPendingFolderDraft(draft);
    startInlineEdit(pendingId, 'folder', '');
  };

  // 连续新建时，先让旧输入框的 blur 完成提交/取消，再开始下一份草稿。
  if (pendingFolderDraftRef.current) {
    requestAnimationFrame(beginDraft);
  } else {
    beginDraft();
  }
}

export interface ConfirmInlineEditContext {
  cancelInlineEdit: () => void;
  pendingFolderDraftRef: React.MutableRefObject<PendingFolderDraft | null>;
  setPendingFolderDraft: React.Dispatch<React.SetStateAction<PendingFolderDraft | null>>;
  isMountedRef: React.MutableRefObject<boolean>;
  t: SidebarT;
  handleRefresh: () => Promise<void>;
  items: DstuNode[];
  inlineEdit: Pick<InlineEditState, 'editingType'>;
  mode: LearningHubSidebarProps['mode'];
}

/** 内联编辑确认：提交新文件夹草稿，或重命名文件夹 / 资源（记录 Cmd+Z 撤销） */
export async function confirmInlineEdit(
  {
    cancelInlineEdit,
    pendingFolderDraftRef,
    setPendingFolderDraft,
    isMountedRef,
    t,
    handleRefresh,
    items,
    inlineEdit,
    mode,
  }: ConfirmInlineEditContext,
  itemId: string,
  newName: string,
): Promise<void> {
  if (!newName.trim()) {
    if (isPendingFolderId(itemId)) {
      if (pendingFolderDraftRef.current?.node.id !== itemId) return;
      pendingFolderDraftRef.current = null;
      setPendingFolderDraft(null);
    }
    cancelInlineEdit();
    return;
  }

  if (isPendingFolderId(itemId)) {
    const draft = pendingFolderDraftRef.current;
    // 旧输入框的延迟 blur 不得提交或清除后来创建的新草稿。
    if (!draft || draft.node.id !== itemId) return;

    cancelInlineEdit();
    pendingFolderDraftRef.current = null;
    setPendingFolderDraft(null);
    const result = await folderApi.createFolder(
      newName.trim(),
      draft.parentFolderId ?? undefined
    );

    if (!isMountedRef.current) return;
    if (result.ok) {
      showGlobalNotification('success', t('finder.create.folderSuccess'));
      await handleRefresh();
    } else {
      reportError(result.error, 'create folder');
      showGlobalNotification('error', result.error.toUserMessage());
    }
    return;
  }

  const item = items.find(i => i.id === itemId);
  if (!item) {
    cancelInlineEdit();
    return;
  }

  // 如果名称没有变化，直接取消
  if (newName.trim() === item.name) {
    cancelInlineEdit();
    return;
  }

  // 保存编辑类型（因为 cancelInlineEdit 会重置它）
  const editingType = inlineEdit.editingType;

  // 先取消编辑状态，避免 UI 闪烁
  cancelInlineEdit();

  let renameResult;

  if (editingType === 'folder') {
    // 重命名文件夹
    renameResult = await folderApi.renameFolder(itemId, newName.trim());
  } else {
    // 重命名资源 - 使用 DSTU rename API
    const resourcePath = item.path;
    if (!resourcePath) {
      showGlobalNotification('error', t('contextMenu.renameError'));
      if (isMountedRef.current) {
        await handleRefresh();
      }
      return;
    }
    renameResult = await dstu.rename(resourcePath, newName.trim());
  }

  // ★ Cmd+Z 撤销：记录重命名（组件卸载与否不影响入栈）
  if (renameResult.ok && mode !== 'canvas') {
    finderUndoStack.push({
      kind: 'rename',
      targetType: editingType === 'folder' ? 'folder' : 'resource',
      id: itemId,
      path: item.path ?? null,
      oldName: item.name,
      newName: newName.trim(),
    });
  }

  // ★ MEDIUM-005: 检查组件是否已卸载
  if (!isMountedRef.current) return;

  if (renameResult.ok) {
    showGlobalNotification('success', t('contextMenu.renameSuccess'));
    await handleRefresh();
  } else {
    reportError(renameResult.error, 'rename');
    showGlobalNotification('error', renameResult.error.toUserMessage());
    // 出错时也需要刷新以恢复原始状态
    await handleRefresh();
  }
}
