import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotesOptional } from '../NotesContext';
import { getPathToNote } from '../notesUtils';
import { ChevronRight, Folder, FileText } from 'lucide-react';
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface NotesEditorHeaderProps {
    lastSaved: Date | null;
    isSaving?: boolean;
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

    // Calculate Breadcrumbs（仅 Context 模式）
    const breadcrumbs = useMemo(() => {
        if (isDstuMode || !contextActive) return [];
        return getPathToNote(contextActive.id, folders as Record<string, { title: string; children: string[] }>, notes);
    }, [isDstuMode, contextActive, folders, notes]);

    // Only show breadcrumbs if not in root (length > 1 means it has parents)
    const showBreadcrumbs = breadcrumbs.length > 1;

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

        // Don't submit if unchanged
        if (titleInput.trim() === (displayTitle || "").trim()) {
            pendingTitleRef.current = null;
            return;
        }

        // Store the pending title to prevent useEffect from reverting
        pendingTitleRef.current = titleInput;
        
        if (isDstuMode) {
            // DSTU 模式：调用 props 的 onTitleChange
            if (dstuOnTitleChange) {
                try {
                    await dstuOnTitleChange(titleInput);
                } catch (error: unknown) {
                    // 标题保存失败，回滚
                    pendingTitleRef.current = null;
                    setTitleInput(displayTitle);
                    showGlobalNotification('error', t('notes:errors.title_save_failed', '标题保存失败'));
                }
            }
        } else {
            // Context 模式：调用 NotesContext.renameItem
            if (renameItem) {
                renameItem(noteId, titleInput);
            }
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.currentTarget.blur(); // Triggers onBlur -> handleTitleSubmit
        }
    };

    if (!noteId) return null;

    return (
        <div className="mt-5 mb-0 group relative">
            <input
                className="text-3xl font-bold text-foreground/90 bg-transparent border-none outline-none placeholder:text-muted-foreground/30 w-full p-0 focus-visible:ring-0"
                value={titleInput}
                onChange={readOnly ? undefined : handleTitleChange}
                onBlur={readOnly ? undefined : handleTitleSubmit}
                onKeyDown={readOnly ? undefined : handleKeyDown}
                placeholder={t('notes:common.untitled')}
                readOnly={readOnly}
            />
            
             {/* Meta info & Breadcrumbs */}
             <div className="flex items-center gap-4 mt-2 min-h-[20px]">
                {/* Breadcrumbs (Left aligned) - Only show if nested in folders */}
                {showBreadcrumbs && (
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60 overflow-hidden whitespace-nowrap mask-linear-fade select-none mr-auto">
                        {breadcrumbs.map((item, index) => (
                            <React.Fragment key={item.id}>
                                {index > 0 && <ChevronRight className="h-3 w-3 opacity-40" />}
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

                {/* Save status (Right aligned) */}
                <div className={`text-[10px] shrink-0 ${showBreadcrumbs ? 'ml-auto' : 'ml-0'} flex items-center gap-2`}>
                    {isSaving && (
                        <span className="text-muted-foreground/40">
                            {t('notes:common.saving')}
                        </span>
                    )}
                    {!isSaving && lastSaved && (
                        <span className="text-muted-foreground/40">
                            {t('notes:common.saved_at', { time: lastSaved.toLocaleTimeString() })}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};
