import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DsButton } from '@/components/ui/DsButton';
import { useNotes } from "../NotesContext";
import { getErrorMessage } from "../../../utils/errorUtils";
import { Trash, ArrowCounterClockwise, ArrowsClockwise, X } from "@phosphor-icons/react";
import { format } from "date-fns";
import { dstu } from "@/dstu";

type TrashItem = {
    id: string;
    title: string;
    updatedAt: number;
};

type ConfirmState =
    | { type: 'hard'; id: string; title: string }
    | { type: 'empty' }
    | null;

/**
 * Legacy notes trash (NotesHome host). Rendered as a non-modal inline panel
 * anchored to the right edge of the positioned host container — no fullscreen
 * scrim, no focus trap. Permanent-delete / empty confirmations are inline
 * strips (the old DsAlertDialog is no longer used); Escape collapses the
 * confirm first, then closes the panel. Export name kept for compatibility.
 */
export function TrashDialog() {
    const { t } = useTranslation(['notes', 'common']);
    const { trashOpen, setTrashOpen, notify, refreshNotes } = useNotes();

    const [loading, setLoading] = useState(false);
    const [items, setItems] = useState<TrashItem[]>([]);
    const [confirm, setConfirm] = useState<ConfirmState>(null);

    const loadTrash = useCallback(async () => {
        if (!trashOpen) return;
        setLoading(true);
        try {
            const res = await dstu.listDeleted('notes', 200, 0);
            if (!res.ok) {
                throw new Error(res.error.toUserMessage());
            }
            setItems(
                res.value.map((node) => ({
                    id: node.id,
                    title: node.name || '',
                    updatedAt: node.updatedAt,
                }))
            );
        } catch (error: unknown) {
            console.error("Failed to load trash", error);
            notify({
                title: t('notes:trash.load_failed'),
                description: getErrorMessage(error),
                variant: "destructive"
            });
        } finally {
            setLoading(false);
        }
    }, [trashOpen, notify, t]);

    useEffect(() => {
        if (trashOpen) {
            setConfirm(null);
            loadTrash();
        }
    }, [trashOpen, loadTrash]);

    // Escape: collapse inline confirm first, then close (non-modal panel).
    useEffect(() => {
        if (!trashOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            if (confirm) {
                setConfirm(null);
                return;
            }
            setTrashOpen(false);
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [confirm, setTrashOpen, trashOpen]);

    /** Optimistic restore with rollback toast on failure. */
    const handleRestore = async (item: TrashItem) => {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
        try {
            const res = await dstu.restore(`/${item.id}`);
            if (!res.ok) {
                throw new Error(res.error.toUserMessage());
            }
            notify({ title: t('notes:trash.restore_success'), variant: "success" });
            refreshNotes(); // Refresh main list
        } catch (error: unknown) {
            setItems((current) =>
                [...current, item].sort((a, b) => b.updatedAt - a.updatedAt));
            notify({
                title: t('notes:trash.restore_failed'),
                description: getErrorMessage(error),
                variant: "destructive"
            });
        }
    };

    const handleHardDelete = async () => {
        if (!confirm) return;
        const snapshot = items;
        setConfirm(null);
        if (confirm.type === 'empty') {
            setItems([]);
        } else {
            setItems((current) => current.filter((entry) => entry.id !== confirm.id));
        }
        try {
            if (confirm.type === 'empty') {
                const res = await dstu.purgeAll('notes');
                if (!res.ok) {
                    throw new Error(res.error.toUserMessage());
                }
                notify({ title: t('notes:trash.empty_success'), variant: "success" });
            } else {
                const res = await dstu.purge(`/${confirm.id}`);
                if (!res.ok) {
                    throw new Error(res.error.toUserMessage());
                }
                notify({ title: t('notes:trash.delete_success'), variant: "success" });
            }
        } catch (error: unknown) {
            setItems(snapshot);
            notify({
                title: t('notes:trash.delete_failed'),
                description: getErrorMessage(error),
                variant: "destructive"
            });
        }
    };

    if (!trashOpen) return null;

    const confirmBar = (labelTitle: string, labelDesc: string) => (
        <div
            role="alertdialog"
            aria-label={labelTitle}
            className="ui-rise-in mb-2 flex flex-col gap-2 rounded-[var(--notes-radius-control)] border border-destructive/35 bg-destructive/10 px-3 py-2.5"
        >
            <div className="space-y-0.5 text-xs leading-relaxed">
                <p className="text-[13px] font-semibold text-destructive">{labelTitle}</p>
                <p className="text-muted-foreground">{labelDesc}</p>
            </div>
            <div className="flex justify-end gap-2">
                <DsButton variant="outline" size="sm" onClick={() => setConfirm(null)}>
                    {t('common:actions.cancel')}
                </DsButton>
                <DsButton variant="danger" size="sm" onClick={() => void handleHardDelete()}>
                    {t('common:actions.confirm')}
                </DsButton>
            </div>
        </div>
    );

    return (
        <section
            role="dialog"
            aria-label={t('notes:trash.title')}
            className="ui-rise-in absolute right-3 top-3 bottom-3 z-[60] flex w-[min(400px,calc(100%-24px))] flex-col rounded-[var(--notes-radius-popup)] border border-border bg-popover p-3.5 text-popover-foreground shadow-[var(--notes-dialog-shadow)]"
        >
            <div className="mb-3 flex items-start justify-between gap-2">
                <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
                    <Trash className="h-[18px] w-[18px] text-destructive" />
                    {t('notes:trash.title')}
                    {items.length > 0 && (
                        <span className="rounded-full bg-muted/70 px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                            {items.length}
                        </span>
                    )}
                </h2>
                <div className="flex items-center gap-1.5">
                    <DsButton
                        variant="ghost"
                        size="icon"
                        onClick={() => void loadTrash()}
                        disabled={loading}
                        aria-label={t('common:actions.refresh', '刷新')}
                        title={t('common:actions.refresh', '刷新')}
                    >
                        <ArrowsClockwise className="h-4 w-4" />
                    </DsButton>
                    <DsButton
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirm({ type: 'empty' })}
                        disabled={items.length === 0 || loading}
                        className="text-destructive hover:text-destructive"
                    >
                        {t('notes:trash.empty_trash')}
                    </DsButton>
                    <DsButton
                        variant="ghost"
                        size="icon"
                        onClick={() => setTrashOpen(false)}
                        aria-label={t('common:actions.close', '关闭')}
                        title={t('common:actions.close', '关闭')}
                    >
                        <X className="h-4 w-4" />
                    </DsButton>
                </div>
            </div>

            {confirm?.type === 'empty' && confirmBar(
                t('notes:trash.confirm_empty_title'),
                t('notes:trash.confirm_empty_desc'),
            )}

            <div className="min-h-0 flex-1 overflow-auto border-t border-border/60">
                {loading ? (
                    <div className="flex justify-center py-8">
                        <span className="loading loading-spinner loading-md" />
                    </div>
                ) : items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                        <span className="grid h-[52px] w-[52px] place-items-center rounded-full bg-muted/45 text-muted-foreground/75">
                            <Trash className="h-6 w-6" />
                        </span>
                        <p className="text-sm">{t('notes:trash.empty_placeholder')}</p>
                    </div>
                ) : (
                    <div className="space-y-1 py-2">
                        {items.map(item => (
                            <React.Fragment key={item.id}>
                                <div className="flex items-center justify-between rounded-[var(--notes-radius-row)] p-2.5 hover:bg-[var(--interactive-hover)] transition-colors">
                                    <div className="min-w-0 flex-1 mr-3">
                                        <h4 className="truncate text-sm font-medium">{item.title || t('notes:common.untitled')}</h4>
                                        <p className="mt-0.5 text-xs text-muted-foreground">
                                            {t('notes:common.deleted_at')}: {item.updatedAt ? format(new Date(item.updatedAt), 'yyyy-MM-dd HH:mm') : '-'}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <DsButton
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => void handleRestore(item)}
                                            title={t('notes:trash.restore')}
                                            aria-label={t('notes:trash.restore')}
                                        >
                                            <ArrowCounterClockwise className="h-4 w-4 text-primary" />
                                        </DsButton>
                                        <DsButton
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setConfirm({ type: 'hard', id: item.id, title: item.title })}
                                            title={t('notes:trash.delete_permanently')}
                                            aria-label={t('notes:trash.delete_permanently')}
                                        >
                                            <X className="h-4 w-4 text-destructive" />
                                        </DsButton>
                                    </div>
                                </div>
                                {confirm?.type === 'hard' && confirm.id === item.id && confirmBar(
                                    t('notes:trash.confirm_delete_title'),
                                    t('notes:trash.confirm_hard_delete', { name: item.title || t('notes:common.untitled') }),
                                )}
                            </React.Fragment>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
