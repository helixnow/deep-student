import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';

const MAX_TOAST_TITLE_LENGTH = 36;

function formatToastNoteTitle(noteTitle: string): string {
  const trimmed = noteTitle.trim();
  if (!trimmed) return '';
  if (trimmed.length <= MAX_TOAST_TITLE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_TOAST_TITLE_LENGTH - 1)}…`;
}

export interface MoveNoteToTrashOptions {
  noteId: string;
  noteTitle?: string;
  /** Runs before dstu.delete (e.g. pause autosave / clear dirty guard so deletion closes cleanly). */
  beforeDelete?: () => void | Promise<void>;
  /** Runs if dstu.delete fails or throws so callers can restore any pre-delete state. */
  onDeleteFailed?: () => void | Promise<void>;
  /** Runs after dstu.delete succeeds and the note workspace resource has been closed. */
  afterDelete?: () => void | Promise<void>;
  /** Runs after the Undo action restores the note from Trash. */
  afterRestore?: () => void | Promise<void>;
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
  afterRestore,
}: MoveNoteToTrashOptions): Promise<boolean> {
  if (!noteId) return false;

  try {
    await beforeDelete?.();

    const [
      { dstu, trashApi, emitDstuFolderChange },
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

    const displayTitle = formatToastNoteTitle(noteTitle);
    const baseMovedMessage = i18n.t('notes:actions.moved_to_trash', { defaultValue: '笔记已移至回收站' });
    const movedMessage = displayTitle ? `${baseMovedMessage} · ${displayTitle}` : baseMovedMessage;

    let undoConsumed = false;
    let undoInFlight = false;
    showGlobalNotification(
      'success',
      movedMessage,
      undefined,
      {
        action: {
          label: i18n.t('notes:actions.undo', { defaultValue: '撤销' }),
          onClick: async () => {
            if (undoConsumed || undoInFlight) return;
            undoInFlight = true;
            try {
              const res = await trashApi.restoreItem(noteId, 'note');
              if (!res.ok) {
                showGlobalNotification('error', res.error.toUserMessage());
                return;
              }
              undoConsumed = true;
              emitDstuFolderChange?.({
                kind: 'item-added',
                itemId: noteId,
                itemType: 'note',
              });
              await afterRestore?.();
              const baseRestoredMessage = i18n.t('notes:actions.restored_from_trash', {
                defaultValue: '已从回收站恢复笔记',
              });
              showGlobalNotification(
                'success',
                displayTitle ? `${baseRestoredMessage} · ${displayTitle}` : baseRestoredMessage,
              );
            } catch (err) {
              showGlobalNotification('error', err instanceof Error ? err.message : String(err));
            } finally {
              undoInFlight = false;
            }
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
