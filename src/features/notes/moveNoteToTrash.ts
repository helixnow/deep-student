import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';

export interface MoveNoteToTrashOptions {
  noteId: string;
  noteTitle?: string;
  /** Runs before dstu.delete (e.g. pause autosave / clear dirty guard so deletion closes cleanly). */
  beforeDelete?: () => void | Promise<void>;
  /** Runs if dstu.delete fails or throws so callers can restore any pre-delete state. */
  onDeleteFailed?: () => void | Promise<void>;
  /** Runs after dstu.delete succeeds and the note workspace resource has been closed. */
  afterDelete?: () => void | Promise<void>;
}

/**
 * Soft-delete a note into Trash, record an undo entry, close its open workspace tab,
 * and show a notification with a one-click Undo action.
 */
export async function moveNoteToTrash({
  noteId,
  noteTitle = '',
  beforeDelete,
  onDeleteFailed,
  afterDelete,
}: MoveNoteToTrashOptions): Promise<boolean> {
  if (!noteId) return false;

  try {
    await beforeDelete?.();

    const [
      { dstu, trashApi },
      { finderUndoStack },
      { closeWorkspaceResource },
    ] = await Promise.all([
      import('@/dstu'),
      import('@/features/learning-hub'),
      import('@/features/workbench'),
    ]);

    const delRes = await dstu.delete(`/${noteId}`);
    if (!delRes.ok) {
      await onDeleteFailed?.();
      showGlobalNotification('error', delRes.error.toUserMessage());
      return false;
    }

    finderUndoStack.push({
      kind: 'soft-delete',
      targets: [{ id: noteId, type: 'note', name: noteTitle }],
    });

    await closeWorkspaceResource({ type: 'note', id: noteId }).catch(() => false);
    await afterDelete?.();

    let undoConsumed = false;
    showGlobalNotification(
      'success',
      i18n.t('notes:actions.moved_to_trash', { defaultValue: '笔记已移至回收站' }),
      undefined,
      {
        action: {
          label: i18n.t('notes:actions.undo', { defaultValue: '撤销' }),
          onClick: () => {
            if (undoConsumed) return;
            undoConsumed = true;
            void trashApi
              .restoreItem(noteId, 'note')
              .then((res) => {
                if (res.ok) {
                  showGlobalNotification(
                    'success',
                    i18n.t('notes:actions.restored_from_trash', { defaultValue: '已从回收站恢复笔记' }),
                  );
                } else {
                  showGlobalNotification('error', res.error.toUserMessage());
                }
              })
              .catch((err) => showGlobalNotification('error', err instanceof Error ? err.message : String(err)));
          },
        },
      },
    );

    return true;
  } catch (error) {
    await onDeleteFailed?.();
    showGlobalNotification('error', error instanceof Error ? error.message : String(error));
    return false;
  }
}
