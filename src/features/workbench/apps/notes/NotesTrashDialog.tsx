import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowsClockwise,
  FileText,
  FolderSimple,
  Trash,
  TreeStructure,
  X,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { trashApi, type DstuNode } from '@/dstu';
import { cn } from '@/lib/utils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import './NotesTrashDialog.css';

/** Workspace trash supports notes, mind maps, and folders. */
export type NotesTrashItemType = 'note' | 'mindmap' | 'folder';

export interface NotesTrashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after restore / permanent delete / empty so the host can refresh the explorer tree. */
  onChanged?: () => void | Promise<void>;
  className?: string;
  /** Page size for `trashApi.listTrash`. */
  limit?: number;
}

type ConfirmState =
  | { kind: 'purge'; node: DstuNode; type: NotesTrashItemType }
  | { kind: 'empty'; count: number }
  | null;

const trashItemType = (value: unknown): NotesTrashItemType | null => {
  if (value === 'note' || value === 'mindmap' || value === 'folder') return value;
  return null;
};

const sortByDeletedDesc = (items: DstuNode[]): DstuNode[] =>
  items.slice().sort((a, b) => b.updatedAt - a.updatedAt);

function resolveLocale(locale: string): string {
  return locale.startsWith('zh') ? 'zh-CN' : locale;
}

function formatDeletedAt(updatedAt: number, locale: string): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(resolveLocale(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Locale-aware month heading used to group entries by deletion time. */
function monthLabel(updatedAt: number, locale: string): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(resolveLocale(locale), { year: 'numeric', month: 'long' });
}

const TrashGlyph: React.FC<{ type: NotesTrashItemType; size?: number }> = ({ type, size = 15 }) => {
  if (type === 'folder') return <FolderSimple size={size} weight="fill" aria-hidden />;
  if (type === 'mindmap') return <TreeStructure size={size} aria-hidden />;
  return <FileText size={size} aria-hidden />;
};

/**
 * Trash for the Notes workspace, rendered as a non-modal panel anchored to
 * the top-right of the workspace (no scrim, no focus trap, outside clicks
 * stay live; the panel hugs its content instead of pinning to the bottom).
 * Confirmations for purge / empty are inline strips instead of a nested
 * overlay; Escape collapses the confirm first, then dismisses the panel.
 * Restore / purge apply optimistically and roll back with a toast on
 * failure. Component name and props are kept for backward compatibility.
 */
export const NotesTrashDialog: React.FC<NotesTrashDialogProps> = ({
  open,
  onOpenChange,
  onChanged,
  className,
  limit = 100,
}) => {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const confirmTitleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<DstuNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const close = useCallback(() => {
    if (busy) return;
    setConfirm(null);
    onOpenChange(false);
  }, [busy, onOpenChange]);

  const loadTrash = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await trashApi.listTrash(limit, 0);
    if (!result.ok) {
      setError(result.error.toUserMessage());
      setItems([]);
    } else {
      const next = sortByDeletedDesc(
        result.value.filter((node) => trashItemType(node.type)),
      );
      setItems(next);
    }
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    if (open) {
      setConfirm(null);
      setFocusIndex(0);
      setSelectedIds(new Set());
      void loadTrash();
    }
  }, [loadTrash, open]);

  // Drop selections that no longer point at a listed item (restore / purge / reload).
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const valid = new Set(items.map((item) => item.id));
      const next = new Set<string>();
      current.forEach((id) => {
        if (valid.has(id)) next.add(id);
      });
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const notifyChanged = useCallback(async () => {
    await onChanged?.();
  }, [onChanged]);

  /** Optimistic restore: drop the row immediately, roll back with a toast on failure. */
  const restoreItem = useCallback(async (node: DstuNode) => {
    const type = trashItemType(node.type);
    if (!type) return;
    setError(null);
    setItems((current) => current.filter((item) => item.id !== node.id));
    const result = await trashApi.restoreItem(node.id, type);
    if (!result.ok) {
      setItems((current) => sortByDeletedDesc([...current, node]));
      showGlobalNotification('error', result.error.toUserMessage());
      return;
    }
    await notifyChanged();
  }, [notifyChanged]);

  /** Batch restore for the current selection; failed rows come back into the list. */
  const restoreSelected = useCallback(async () => {
    if (busy || selectedIds.size === 0) return;
    const targets = items.filter((item) => selectedIds.has(item.id) && trashItemType(item.type));
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    setItems((current) => current.filter((item) => !selectedIds.has(item.id)));
    setSelectedIds(new Set());
    const failed: DstuNode[] = [];
    let lastFailure: string | null = null;
    for (const node of targets) {
      const type = trashItemType(node.type);
      if (!type) continue;
      const result = await trashApi.restoreItem(node.id, type);
      if (!result.ok) {
        failed.push(node);
        lastFailure = result.error.toUserMessage();
      }
    }
    setBusy(false);
    if (failed.length > 0) {
      setItems((current) => sortByDeletedDesc([...current, ...failed]));
      showGlobalNotification('error', lastFailure ?? t('workbench:notesWorkspace.trash.restoreSelectedFailed', {
        count: failed.length,
        defaultValue: 'Could not restore {{count}} item(s).',
      }));
    }
    await notifyChanged();
  }, [busy, items, notifyChanged, selectedIds, t]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) => (
      current.size === items.length && items.length > 0
        ? new Set<string>()
        : new Set(items.map((item) => item.id))
    ));
  }, [items]);

  /** Optimistic permanent delete (after inline confirm). */
  const purgeItem = useCallback(async (node: DstuNode, type: NotesTrashItemType) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConfirm(null);
    setItems((current) => current.filter((item) => item.id !== node.id));
    const result = await trashApi.permanentlyDelete(node.id, type);
    setBusy(false);
    if (!result.ok) {
      setItems((current) => sortByDeletedDesc([...current, node]));
      showGlobalNotification('error', result.error.toUserMessage());
      return;
    }
    await notifyChanged();
  }, [busy, notifyChanged]);

  /** Optimistic empty: clear the list, restore the snapshot on failure. */
  const emptyAll = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConfirm(null);
    const snapshot = items;
    setItems([]);
    const result = await trashApi.emptyTrash();
    setBusy(false);
    if (!result.ok) {
      setItems(snapshot);
      showGlobalNotification('error', result.error.toUserMessage());
      return;
    }
    await notifyChanged();
  }, [busy, items, notifyChanged]);

  // Move focus into the panel on open, hand it back on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previouslyFocused?.focus();
    };
  }, [open]);

  // Escape: collapse the inline confirm first, then dismiss the panel.
  // Intentionally no Tab focus trap — this is a non-modal inline panel.
  const onEscapeKeyDown = useCallback((event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (confirm) {
      if (!busy) setConfirm(null);
      return;
    }
    close();
  }, [busy, close, confirm]);
  useEventRegistry(
    open
      ? [{ target: 'document', type: 'keydown', listener: onEscapeKeyDown, options: true }]
      : [],
    [onEscapeKeyDown, open],
  );

  const locale = i18n.language || 'zh-CN';

  const groups = useMemo(() => {
    const result: Array<{ label: string; items: Array<{ node: DstuNode; index: number }> }> = [];
    items.forEach((node, index) => {
      const label = monthLabel(node.updatedAt, locale);
      const last = result[result.length - 1];
      if (last && last.label === label) {
        last.items.push({ node, index });
      } else {
        result.push({ label, items: [{ node, index }] });
      }
    });
    return result;
  }, [items, locale]);

  // Roving keyboard navigation over rows: ↑/↓ move, Enter restores,
  // Delete / Backspace opens the inline purge confirm.
  const focusRow = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    setFocusIndex(clamped);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-trash-row="${clamped}"]`);
    row?.focus();
  }, [items.length]);

  const onListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const target = event.target as HTMLElement;
    const rowAttr = target.closest<HTMLElement>('[data-trash-row]')?.dataset.trashRow;
    const currentIndex = rowAttr !== undefined ? Number(rowAttr) : focusIndex;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(currentIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(currentIndex - 1);
    } else if (event.key === 'Enter' && target.dataset.trashRow !== undefined) {
      event.preventDefault();
      const node = items[currentIndex];
      if (node) void restoreItem(node);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && target.dataset.trashRow !== undefined) {
      event.preventDefault();
      const node = items[currentIndex];
      const type = node ? trashItemType(node.type) : null;
      if (node && type) setConfirm({ kind: 'purge', node, type });
    }
  }, [focusIndex, focusRow, items, restoreItem]);

  if (!open) return null;

  // Keep the roving tabindex in range after optimistic removals.
  const rovingIndex = Math.min(focusIndex, Math.max(items.length - 1, 0));

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className={cn('ntd-panel ui-rise-in', className)}
      role="region"
      aria-labelledby={titleId}
    >
      <div className="ntd-header">
        <h2 id={titleId}>
          {t('workbench:notesWorkspace.trash.title')}
          {items.length > 0 && <span className="ntd-count">{items.length}</span>}
        </h2>
        <div className="ntd-header-actions">
          <button
            type="button"
            className="ntd-icon-button"
            disabled={loading || busy}
            aria-label={t('workbench:notesWorkspace.tree.retry')}
            title={t('workbench:notesWorkspace.tree.retry')}
            onClick={() => void loadTrash()}
          >
            <ArrowsClockwise size={14} />
          </button>
          <button
            type="button"
            className="ntd-empty-btn"
            disabled={loading || busy || items.length === 0}
            onClick={() => setConfirm({ kind: 'empty', count: items.length })}
          >
            {t('workbench:notesWorkspace.trash.emptyAll', { count: items.length })}
          </button>
          <button
            type="button"
            className="ntd-icon-button"
            aria-label={t('workbench:notesWorkspace.trash.close')}
            title={t('workbench:notesWorkspace.trash.close')}
            onClick={close}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {confirm?.kind === 'empty' && (
        <div
          className="ntd-confirm-bar"
          role="group"
          aria-labelledby={confirmTitleId}
        >
          <div className="ntd-confirm-copy">
            <strong id={confirmTitleId}>
              {t('workbench:notesWorkspace.trash.confirmEmptyTitle')}
            </strong>
            <span>
              {t('workbench:notesWorkspace.trash.confirmEmptyDesc', { count: confirm.count })}
            </span>
          </div>
          <div className="ntd-confirm-actions">
            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
              {t('workbench:notesWorkspace.dialog.cancel')}
            </button>
            <button
              type="button"
              className="is-danger"
              disabled={busy}
              onClick={() => void emptyAll()}
            >
              {t('workbench:notesWorkspace.trash.confirmEmptyAction')}
            </button>
          </div>
        </div>
      )}

      <div className="ntd-body">
        {loading ? (
          <div
            className="ntd-loading"
            aria-label={t('workbench:notesWorkspace.trash.loading')}
          >
            <i /><i /><i />
          </div>
        ) : error ? (
          <div className="ntd-message" data-state="error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void loadTrash()}>
              {t('workbench:notesWorkspace.tree.retry')}
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="ntd-message" data-state="empty">
            <span className="ntd-empty-glyph" aria-hidden>
              <Trash size={26} />
            </span>
            <span>{t('workbench:notesWorkspace.trash.empty')}</span>
          </div>
        ) : (
          <>
            <div className="ntd-select-bar">
              <label className="ntd-select-all">
                <input
                  type="checkbox"
                  checked={selectedIds.size === items.length && items.length > 0}
                  disabled={busy}
                  onChange={toggleSelectAll}
                  aria-label={t('workbench:notesWorkspace.trash.selectAll', {
                    defaultValue: 'Select all',
                  })}
                />
                <span>
                  {t('workbench:notesWorkspace.trash.selectAll', { defaultValue: 'Select all' })}
                </span>
              </label>
              {selectedIds.size > 0 && (
                <button
                  type="button"
                  className="ntd-restore-selected"
                  disabled={busy}
                  onClick={() => void restoreSelected()}
                >
                  {t('workbench:notesWorkspace.trash.restoreSelected', {
                    count: selectedIds.size,
                    defaultValue: 'Restore selected ({{count}})',
                  })}
                </button>
              )}
            </div>
            <CustomScrollArea
              viewportRef={listRef}
              className="ntd-list"
              viewportProps={{ role: 'list', onKeyDown: onListKeyDown }}
              trackOffsetTop={4}
              trackOffsetBottom={6}
              trackOffsetRight={3}
            >
            {groups.map((group) => (
              <React.Fragment key={group.label || 'undated'}>
                {group.label && (
                  <div className="ntd-group-label" aria-hidden>{group.label}</div>
                )}
                {group.items.map(({ node, index }) => {
                  const type = trashItemType(node.type);
                  if (!type) return null;
                  const time = formatDeletedAt(node.updatedAt, locale);
                  const confirmingRow = confirm?.kind === 'purge' && confirm.node.id === node.id;
                  return (
                    <div key={`${type}:${node.id}`} role="listitem" className="ntd-item-shell">
                      <div
                        className="ntd-item"
                        data-trash-row={index}
                        tabIndex={index === rovingIndex ? 0 : -1}
                        aria-label={node.name}
                        onFocus={() => setFocusIndex(index)}
                      >
                        <label className="ntd-item-check-hit">
                          <input
                            type="checkbox"
                            className="ntd-item-check"
                            checked={selectedIds.has(node.id)}
                            disabled={busy}
                            tabIndex={-1}
                            onChange={() => toggleSelected(node.id)}
                            aria-label={t('workbench:notesWorkspace.trash.selectItem', {
                              name: node.name,
                              defaultValue: 'Select {{name}}',
                            })}
                          />
                        </label>
                        <span className="ntd-item-icon"><TrashGlyph type={type} /></span>
                        <div className="ntd-item-meta">
                          <span className="ntd-item-name">{node.name}</span>
                          {time ? (
                            <span className="ntd-item-time">
                              {t('workbench:notesWorkspace.trash.deletedAt', { time })}
                            </span>
                          ) : null}
                        </div>
                        <div className="ntd-item-actions">
                          <button
                            type="button"
                            className="ntd-icon-button"
                            disabled={busy}
                            aria-label={t('workbench:notesWorkspace.trash.restore', { name: node.name })}
                            title={t('workbench:notesWorkspace.trash.restore', { name: node.name })}
                            onClick={() => void restoreItem(node)}
                          >
                            <ArrowsClockwise size={14} />
                          </button>
                          <button
                            type="button"
                            className="ntd-icon-button is-danger"
                            disabled={busy}
                            aria-label={t('workbench:notesWorkspace.trash.purge', { name: node.name })}
                            title={t('workbench:notesWorkspace.trash.purge', { name: node.name })}
                            onClick={() => setConfirm({ kind: 'purge', node, type })}
                          >
                            <Trash size={14} />
                          </button>
                        </div>
                      </div>
                      {confirmingRow && confirm?.kind === 'purge' && (
                        <div className="ntd-row-confirm" role="group" aria-label={t('workbench:notesWorkspace.trash.confirmPurgeTitle')}>
                          <span>
                            {t('workbench:notesWorkspace.trash.confirmPurgeDesc', { name: node.name })}
                          </span>
                          <div className="ntd-confirm-actions">
                            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
                              {t('workbench:notesWorkspace.dialog.cancel')}
                            </button>
                            <button
                              type="button"
                              className="is-danger"
                              disabled={busy}
                              onClick={() => void purgeItem(confirm.node, confirm.type)}
                            >
                              {t('workbench:notesWorkspace.trash.confirmPurgeAction')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
            </CustomScrollArea>
          </>
        )}
      </div>
    </div>
  );
};

export default NotesTrashDialog;
