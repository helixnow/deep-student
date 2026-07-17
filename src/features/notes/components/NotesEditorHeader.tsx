import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotesOptional } from '../NotesContext';
import { getPathToNote } from '../notesUtils';
import { CaretRight, Folder, FileText } from '@phosphor-icons/react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { Input } from '@/components/ui/shad/Input';
import { registerContentDirtyChecker } from '@/features/workbench/apps/content/contentDirtyRegistry';

export type NotesSaveStatus = 'saved' | 'saving' | 'unsaved' | 'failed' | 'conflict';

interface NotesEditorHeaderProps {
    lastSaved: Date | null;
    /** @deprecated Prefer saveStatus; kept for callers that only pass isSaving */
    isSaving?: boolean;
    /** Persistent save chrome: Saved / Saving / Unsaved / Failed / Conflict */
    saveStatus?: NotesSaveStatus;
    /** Retry after failed/conflict save (flush draft) */
    onRetrySave?: () => void | Promise<void>;
    /** 字数统计（非空白字符数） */
    charCount?: number;
    // ========== DSTU 模式 Props ==========
    /** DSTU 模式：初始标题 */
    initialTitle?: string;
    /** DSTU 模式：标题变更回调 */
    onTitleChange?: (title: string) => Promise<void>;
    /** DSTU 模式：笔记 ID */
    noteId?: string;
    /** 是否只读 */
    readOnly?: boolean;
}

export const NotesEditorHeader: React.FC<NotesEditorHeaderProps> = ({ 
    lastSaved, 
    isSaving,
    saveStatus: saveStatusProp,
    onRetrySave,
    charCount,
    initialTitle,
    onTitleChange: dstuOnTitleChange,
    noteId: dstuNoteId,
    readOnly = false,
}) => {
    const { t } = useTranslation(['notes', 'common']);
    
    // ========== 模式判断 ==========
    const isDstuMode = initialTitle !== undefined;
    
    // ========== Context 获取（可选） ==========
    const notesContext = useNotesOptional();
    const contextActive = notesContext?.active;
    const renameItem = notesContext?.renameItem;
    const folders = notesContext?.folders ?? {};
    const notes = notesContext?.notes ?? [];
    const activateTab = notesContext?.activateTab;
    const setSidebarRevealId = notesContext?.setSidebarRevealId;
    
    // Local state for input value to allow typing before commit
    const [titleInput, setTitleInput] = useState("");
    const [isEditing, setIsEditing] = useState(false);
    // Track pending title to prevent useEffect from reverting to old value
    const pendingTitleRef = useRef<string | null>(null);

    // ========== 根据模式选择数据源 ==========
    const noteId = isDstuMode ? dstuNoteId : contextActive?.id;
    
    // Determine display title
    const displayTitle = isDstuMode ? (initialTitle || "") : (contextActive?.title || "");

    const titleDirtyRef = useRef(false);
    const trimmedInput = titleInput.trim();
    titleDirtyRef.current =
        !readOnly &&
        Boolean(noteId) &&
        Boolean(trimmedInput) &&
        trimmedInput !== (displayTitle || '').trim() &&
        (isEditing || pendingTitleRef.current !== null);

    useEffect(() => {
        if (!isDstuMode || !noteId || readOnly) return;
        return registerContentDirtyChecker('note', noteId, () => titleDirtyRef.current);
    }, [isDstuMode, noteId, readOnly]);

    // Calculate Breadcrumbs（仅 Context 模式）
    const breadcrumbs = useMemo(() => {
        if (isDstuMode || !contextActive) return [];
        return getPathToNote(contextActive.id, folders as Record<string, { title: string; children: string[] }>, notes);
    }, [isDstuMode, contextActive, folders, notes]);

    // Only show breadcrumbs if not in root (length > 1 means it has parents)
    const showBreadcrumbs = breadcrumbs.length > 1;

    const saveStatus: NotesSaveStatus =
        saveStatusProp ??
        (isSaving ? 'saving' : 'saved');

    const handleBreadcrumbClick = (item: { id: string; title: string; type: 'folder' | 'note' }) => {
        if (isDstuMode) return; // DSTU 模式下无面包屑导航
        if (item.type === 'folder') {
             // Reveal in sidebar
             if (setSidebarRevealId) setSidebarRevealId(item.id);
        } else {
             // Activate note
             const note = notes.find(n => n.id === item.id);
             if (note && activateTab) activateTab(note.id);
        }
    };

    // Sync local state with external source when not editing
    useEffect(() => {
        if (!isEditing) {
            // If we have a pending title, use it until displayTitle catches up
            if (pendingTitleRef.current !== null) {
                if (displayTitle === pendingTitleRef.current) {
                    // Context has updated, clear pending
                    pendingTitleRef.current = null;
                    setTitleInput(displayTitle);
                } else {
                    // Keep showing the pending title
                    setTitleInput(pendingTitleRef.current);
                }
            } else {
                setTitleInput(displayTitle);
            }
        }
    }, [displayTitle, isEditing]);

    const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (readOnly) return;
        setTitleInput(e.target.value);
        setIsEditing(true);
    };

    const handleTitleSubmit = async () => {
        if (readOnly) return;
        setIsEditing(false);
        if (!noteId) return;

        // ★ Y9 修复：提交前 trim，避免首尾空白进入数据；
        // 纯空白标题不提交（后端会拒绝空标题），直接回滚为原标题。
        const trimmedTitle = titleInput.trim();
        if (!trimmedTitle) {
            pendingTitleRef.current = null;
            setTitleInput(displayTitle);
            return;
        }

        // Don't submit if unchanged
        if (trimmedTitle === (displayTitle || "").trim()) {
            pendingTitleRef.current = null;
            setTitleInput(trimmedTitle);
            return;
        }

        // Store the pending title to prevent useEffect from reverting
        pendingTitleRef.current = trimmedTitle;
        setTitleInput(trimmedTitle);
        
        if (isDstuMode) {
            // DSTU 模式：调用 props 的 onTitleChange
            if (dstuOnTitleChange) {
                try {
                    await dstuOnTitleChange(trimmedTitle);
                } catch (error: unknown) {
                    // 标题保存失败，回滚
                    pendingTitleRef.current = null;
                    setTitleInput(displayTitle);
                    showGlobalNotification('error', t('notes:errors.title_save_failed'));
                }
            }
        } else {
            // Context 模式：调用 NotesContext.renameItem
            if (renameItem) {
                renameItem(noteId, trimmedTitle);
            }
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.currentTarget.blur(); // Triggers onBlur -> handleTitleSubmit
        }
    };

    // ★ F6 修复：标题编辑中直接关闭标签页（不触发 blur）时，卸载前提交修改，
    // 防止已输入的标题被静默丢弃。
    const unmountFlushRef = useRef({ isEditing, titleInput, displayTitle, noteId, readOnly });
    unmountFlushRef.current = { isEditing, titleInput, displayTitle, noteId, readOnly };
    const dstuOnTitleChangeRef = useRef(dstuOnTitleChange);
    dstuOnTitleChangeRef.current = dstuOnTitleChange;
    const renameItemRef = useRef(renameItem);
    renameItemRef.current = renameItem;

    useEffect(() => {
        return () => {
            const snap = unmountFlushRef.current;
            if (snap.readOnly || !snap.isEditing || !snap.noteId) return;
            const trimmed = snap.titleInput.trim();
            if (!trimmed || trimmed === (snap.displayTitle || '').trim()) return;
            if (dstuOnTitleChangeRef.current) {
                dstuOnTitleChangeRef.current(trimmed).catch((err) => {
                    console.warn('[NotesEditorHeader] Unmount title flush failed:', err);
                });
            } else if (renameItemRef.current) {
                renameItemRef.current(snap.noteId, trimmed);
            }
        };
    }, []);

    const statusLabel = (() => {
        switch (saveStatus) {
            case 'saving':
                return t('notes:editor.save_status.saving');
            case 'unsaved':
                return t('notes:editor.save_status.unsaved');
            case 'failed':
                return t('notes:editor.save_status.save_failed');
            case 'conflict':
                return t('notes:editor.save_status.conflict');
            case 'saved':
            default:
                return lastSaved
                    ? t('notes:editor.save_status.saved_at', { time: lastSaved.toLocaleTimeString() })
                    : t('notes:editor.save_status.saved');
        }
    })();

    const statusClassName = (() => {
        switch (saveStatus) {
            case 'failed':
            case 'conflict':
                return 'text-destructive';
            case 'saving':
            case 'unsaved':
                return 'text-muted-foreground';
            default:
                return 'text-muted-foreground/70';
        }
    })();

    // 仅 transient 失败提供重试。冲突时外部版本通常已胜出，盲目 flush 会再次撞锁；
    // 恢复入口在 NoteContentView 的冲突通知「恢复我的版本」。
    const showRetry =
        !readOnly &&
        !!onRetrySave &&
        saveStatus === 'failed';

    if (!noteId) return null;

    return (
        <header className="notes-document-header group relative pt-7 pb-3">
            <Input
                className="h-auto w-full border-none bg-transparent p-0 font-semibold leading-[1.2] text-foreground shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
                style={{ fontSize: 'clamp(26px, 5.2vw, 40px)' }}
                value={titleInput}
                onChange={readOnly ? undefined : handleTitleChange}
                onBlur={readOnly ? undefined : handleTitleSubmit}
                onKeyDown={readOnly ? undefined : handleKeyDown}
                placeholder={t('notes:common.untitled')}
                readOnly={readOnly}
            />
            
             {/* Meta info & Breadcrumbs */}
             <div className="mt-2 flex min-h-5 items-center gap-4">
                {/* Breadcrumbs (Left aligned) - Only show if nested in folders */}
                {showBreadcrumbs && (
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60 overflow-hidden whitespace-nowrap mask-linear-fade select-none mr-auto">
                        {breadcrumbs.map((item, index) => (
                            <React.Fragment key={item.id}>
                                {index > 0 && <CaretRight className="h-3 w-3 opacity-40" />}
                                <div 
                                    className={`flex items-center gap-1 ${
                                    index === breadcrumbs.length - 1 
                                        ? 'text-foreground/70 font-medium' 
                                        : 'text-muted-foreground/60 hover:text-foreground/80 transition-colors cursor-pointer'
                                }`}
                                    onClick={() => handleBreadcrumbClick(item)}
                                >
                                    {item.type === 'folder' ? (
                                        <>
                                            <Folder className="h-3 w-3 opacity-70" />
                                            <span className="truncate max-w-[100px]">{item.title}</span>
                                        </>
                                    ) : (
                                        <>
                                            <FileText className="h-3 w-3 opacity-70" />
                                            <span className="truncate max-w-[150px]">{item.title}</span>
                                        </>
                                    )}
                                </div>
                            </React.Fragment>
                        ))}
                    </div>
                )}

                {/* Save status & word count (Right aligned) */}
                <div
                    className={`notes-document-meta shrink-0 ${showBreadcrumbs ? 'ml-auto' : 'ml-0'} flex items-center gap-2 text-[11px] ${saveStatus === 'saved' ? 'notes-document-meta-saved' : ''}`}
                    aria-live="polite"
                >
                    {typeof charCount === 'number' && charCount > 0 && (
                        <span className="text-muted-foreground/70 tabular-nums">
                            {t('notes:common.char_count', { count: charCount })}
                        </span>
                    )}
                    <span className={`inline-flex items-center gap-1.5 ${statusClassName}`}>
                        <span className="notes-save-status-dot" data-status={saveStatus} aria-hidden="true" />
                        <span>{statusLabel}</span>
                        {showRetry && (
                            <button
                                type="button"
                                className="underline underline-offset-2 hover:text-destructive/90 transition-colors"
                                onClick={() => {
                                    void onRetrySave?.();
                                }}
                            >
                                {t('notes:editor.save_status.retry')}
                            </button>
                        )}
                    </span>
                </div>
            </div>
        </header>
    );
};
