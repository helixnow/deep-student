import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
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

function formatDeletedAt(updatedAt: number, locale: string): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale.startsWith('zh') ? 'zh-CN' : locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const TrashGlyph: React.FC<{ type: NotesTrashItemType; size?: number }> = ({ type, size = 15 }) => {
  if (type === 'folder') return <FolderSimple size={size} weight="fill" aria-hidden />;
  if (type === 'mindmap') return <TreeStructure size={size} aria-hidden />;
  return <FileText size={size} aria-hidden />;
};

/**
 * Controlled trash dialog for the Notes workspace.
 * Owns its own list/load/confirm state; does not read workspace store.
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<DstuNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

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
      const next = result.value
        .filter((node) => trashItemType(node.type))
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setItems(next);
    }
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    if (open) {
      setConfirm(null);
      void loadTrash();
    }
  }, [loadTrash, open]);

  const notifyChanged = useCallback(async () => {
    await onChanged?.();
  }, [onChanged]);

  const restoreItem = useCallback(async (node: DstuNode) => {
    const type = trashItemType(node.type);
    if (!type || busy) return;
    setBusy(true);
    setError(null);
    const result = await trashApi.restoreItem(node.id, type);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.toUserMessage());
      return;
    }
    setItems((current) => current.filter((item) => item.id !== node.id));
    await notifyChanged();
  }, [busy, notifyChanged]);

  const purgeItem = useCallback(async (node: DstuNode, type: NotesTrashItemType) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await trashApi.permanentlyDelete(node.id, type);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.toUserMessage());
      return;
    }
    setConfirm(null);
    setItems((current) => current.filter((item) => item.id !== node.id));
    await notifyChanged();
  }, [busy, notifyChanged]);

  const emptyAll = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await trashApi.emptyTrash();
    setBusy(false);
    if (!result.ok) {
      setError(result.error.toUserMessage());
      return;
    }
    setConfirm(null);
    setItems([]);
    await notifyChanged();
  }, [busy, notifyChanged]);

  // Focus trap + Escape (confirm layer takes priority when open).
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const focusRoot = () => (confirm ? confirmRef.current : dialogRef.current);
    const focusable = () => Array.from(focusRoot()?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);

    const frame = window.requestAnimationFrame(() => focusable()[0]?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (confirm) {
          if (!busy) setConfirm(null);
          return;
        }
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [busy, close, confirm, open]);

  if (!open) return null;

  const locale = i18n.language || 'zh-CN';

  return (
    <div
      className={cn('ntd-scrim', className)}
      role="presentation"
      onPointerDown={close}
    >
      <div
        ref={dialogRef}
        className="ntd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="ntd-header">
          <h2 id={titleId}>
            {t('workbench:notesWorkspace.trash.title')}
          </h2>
          <div className="ntd-header-actions">
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
              <span>{t('workbench:notesWorkspace.trash.empty')}</span>
            </div>
          ) : (
            <div className="ntd-list">
              {items.map((node) => {
                const type = trashItemType(node.type);
                if (!type) return null;
                const time = formatDeletedAt(node.updatedAt, locale);
                return (
                  <div key={`${type}:${node.id}`} className="ntd-item">
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
                );
              })}
            </div>
          )}
        </div>

        {confirm && (
          <div
            className="ntd-confirm-scrim"
            role="presentation"
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!busy) setConfirm(null);
            }}
          >
            <div
              ref={confirmRef}
              className="ntd-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={confirmTitleId}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <h3 id={confirmTitleId}>
                {confirm.kind === 'empty'
                  ? t('workbench:notesWorkspace.trash.confirmEmptyTitle')
                  : t('workbench:notesWorkspace.trash.confirmPurgeTitle')}
              </h3>
              <p>
                {confirm.kind === 'empty'
                  ? t('workbench:notesWorkspace.trash.confirmEmptyDesc', { count: confirm.count })
                  : t('workbench:notesWorkspace.trash.confirmPurgeDesc', { name: confirm.node.name })}
              </p>
              <div className="ntd-confirm-actions">
                <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
                  {t('workbench:notesWorkspace.dialog.cancel')}
                </button>
                <button
                  type="button"
                  className="is-danger"
                  disabled={busy}
                  onClick={() => void (confirm.kind === 'empty'
                    ? emptyAll()
                    : purgeItem(confirm.node, confirm.type))}
                >
                  {confirm.kind === 'empty'
                    ? t('workbench:notesWorkspace.trash.confirmEmptyAction')
                    : t('workbench:notesWorkspace.trash.confirmPurgeAction')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NotesTrashDialog;
