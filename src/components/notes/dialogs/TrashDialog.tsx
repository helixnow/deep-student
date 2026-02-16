import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody, NotionAlertDialog } from '../../ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotesAPI, type NoteItem } from "../../../utils/notesApi";
import { useNotes } from "../NotesContext";
import { getErrorMessage } from "../../../utils/errorUtils";
import { Trash2, RefreshCw, RotateCcw, X } from "lucide-react";
import { format } from "date-fns";

export function TrashDialog() {
    const { t } = useTranslation(['notes', 'common']);
    const { trashOpen, setTrashOpen, notify, refreshNotes } = useNotes();

    const [loading, setLoading] = useState(false);
    const [items, setItems] = useState<NoteItem[]>([]);
    const [confirmState, setConfirmState] = useState<{ open: boolean; type: 'hard' | 'empty'; id?: string }>({ open: false, type: 'hard' });

    const loadTrash = useCallback(async () => {
        if (!trashOpen) return;
        setLoading(true);
        try {
            const res = await NotesAPI.listDeleted();
            setItems(res.items || []);
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
            loadTrash();
        }
    }, [trashOpen, loadTrash]);

    const handleRestore = async (id: string) => {
        try {
            await NotesAPI.restore(id);
            notify({ title: t('notes:trash.restore_success'), variant: "success" });
            loadTrash();
            refreshNotes(); // Refresh main list
        } catch (error: unknown) {
            notify({
                title: t('notes:trash.restore_failed'),
                description: getErrorMessage(error),
                variant: "destructive"
            });
        }
    };

    const handleHardDelete = async () => {
        if (!confirmState.id && confirmState.type !== 'empty') return;

        try {
            if (confirmState.type === 'empty') {
                await NotesAPI.emptyTrash();
                notify({ title: t('notes:trash.empty_success'), variant: "success" });
            } else if (confirmState.id) {
                await NotesAPI.hardDelete(confirmState.id);
                notify({ title: t('notes:trash.delete_success'), variant: "success" });
            }
            setConfirmState({ open: false, type: 'hard' });
            loadTrash();
        } catch (error: unknown) {
            notify({
                title: t('notes:trash.delete_failed'),
                description: getErrorMessage(error),
                variant: "destructive"
            });
        }
    };

    return (
        <>
            <NotionDialog open={trashOpen} onOpenChange={setTrashOpen} maxWidth="max-w-3xl">
                    <NotionDialogHeader>
                        <div className="flex items-center justify-between">
                            <NotionDialogTitle className="flex items-center gap-2">
                                <Trash2 className="h-5 w-5 text-destructive" />
                                {t('notes:trash.title')}
                            </NotionDialogTitle>
                            <div className="flex items-center gap-2">
                                <NotionButton
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setConfirmState({ open: true, type: 'empty' })}
                                    disabled={items.length === 0 || loading}
                                    className="text-destructive hover:text-destructive"
                                >
                                    {t('notes:trash.empty_trash', 'Empty Trash')}
                                </NotionButton>
                            </div>
                        </div>
                    </NotionDialogHeader>

                    <NotionDialogBody>
                        {loading ? (
                            <div className="flex justify-center py-8">
                                <span className="loading loading-spinner loading-md" />
                            </div>
                        ) : items.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                                <Trash2 className="h-12 w-12 mb-4 opacity-20" />
                                <p>{t('notes:trash.empty_placeholder', 'Trash is empty')}</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {items.map(item => (
                                    <div key={item.id} className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-card hover:bg-accent/50 transition-colors">
                                        <div className="min-w-0 flex-1 mr-4">
                                            <h4 className="font-medium truncate">{item.title || t('notes:common.untitled')}</h4>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {t('notes:common.deleted_at', 'Deleted at')}: {item.updated_at ? format(new Date(item.updated_at), 'yyyy-MM-dd HH:mm') : '-'}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <NotionButton
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => handleRestore(item.id)}
                                                title={t('notes:trash.restore', 'Restore')}
                                            >
                                                <RotateCcw className="h-4 w-4 text-primary" />
                                            </NotionButton>
                                            <NotionButton
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => setConfirmState({ open: true, type: 'hard', id: item.id })}
                                                title={t('notes:trash.delete_permanently', 'Delete Permanently')}
                                            >
                                                <X className="h-4 w-4 text-destructive" />
                                            </NotionButton>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </NotionDialogBody>
            </NotionDialog>

            <NotionAlertDialog
                open={confirmState.open}
                onOpenChange={(open) => setConfirmState(s => ({ ...s, open }))}
                icon={<Trash2 className="h-5 w-5 text-red-500" />}
                title={confirmState.type === 'empty' ? t('notes:trash.confirm_empty_title', 'Confirm Empty') : t('notes:trash.confirm_delete_title', 'Confirm Deletion')}
                description={confirmState.type === 'empty' ? t('notes:trash.confirm_empty_desc', 'Are you sure you want to empty the trash?') : t('notes:trash.confirm_delete_desc', 'Are you sure you want to permanently delete this item?')}
                confirmText={t('common:actions.confirm')}
                cancelText={t('common:actions.cancel')}
                confirmVariant="danger"
                onConfirm={handleHardDelete}
            />
        </>
    );
}
