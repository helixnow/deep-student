import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useNotesOptional } from '../NotesContext';
import { getPathToNote, type NoteContentStats } from '../notesUtils';
import { CaretRight, CircleNotch, Folder, FileText, WarningCircle, Tag as TagIcon, X, Plus, SlidersHorizontal } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { NoteGlyph } from './NoteGlyph';
import { ALL_NOTE_ICONS, NOTE_APPEARANCE_ICONS, NOTE_ICON_GROUPS, useNoteAppearance } from '../noteAppearance';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { registerContentDirtyChecker, registerContentSaveHandler } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { cn } from '@/lib/utils';
import { springSnap, motionSafe } from '@/styles/motion-springs';
import { useTagSuggestions } from '../hooks/useTagSuggestions';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import {
  NOTE_TAG_MAX_CHARS,
  NOTE_TAGS_MAX_COUNT,
  sanitizeNoteTitleInput,
  validateNoteTag,
} from '../noteInputLimits';
import './NotesEditorHeader.css';

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
    /**
     * 完整文档统计（字数/词数/阅读时间，用 notesUtils.computeNoteStats 生成）。
     * 未提供时回退到 charCount：仅展示字数并按 300 字/分估算阅读时间。
     */
    stats?: NoteContentStats;
    // ========== DSTU 模式 Props ==========
    /** DSTU 模式：初始标题 */
    initialTitle?: string;
    /** DSTU 模式：标题变更回调 */
    onTitleChange?: (title: string) => Promise<void>;
    /** DSTU 模式：笔记 ID */
    noteId?: string;
    /** 是否只读 */
    readOnly?: boolean;
    /**
     * P1-10：标题下方内联标签行。
     * DSTU 模式由宿主传入（NoteContentView）；Context 模式缺省时回退 active.tags。
     */
    tags?: string[];
    /** 标签变更回调（DSTU 模式必传才可编辑；Context 模式回退 updateNoteTags） */
    onTagsChange?: (tags: string[]) => Promise<void> | void;
    /** 标题里按 Enter / 末尾按 ↓ 时，把光标送进正文开头 */
    onExitToBody?: () => void;
    /** 新建的空笔记：打开即聚焦标题并全选占位标题，直接输入即可命名 */
    autoFocusTitle?: boolean;
}

export const NotesEditorHeader: React.FC<NotesEditorHeaderProps> = ({ 
    lastSaved, 
    isSaving,
    saveStatus: saveStatusProp,
    onRetrySave,
    charCount,
    stats,
    initialTitle,
    onTitleChange: dstuOnTitleChange,
    noteId: dstuNoteId,
    readOnly = false,
    tags: tagsProp,
    onTagsChange,
    onExitToBody,
    autoFocusTitle = false,
}) => {
    const { t, i18n } = useTranslation(['notes', 'common', 'translation']);
    const isZh = (i18n.language || '').startsWith('zh');
    
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
    const updateNoteTags = notesContext?.updateNoteTags;
    
    // Local state for input value to allow typing before commit
    const [titleInput, setTitleInput] = useState("");
    const titleRef = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        const title = titleRef.current;
        if (!title) return;
        const resize = () => {
            title.style.height = 'auto';
            title.style.height = `${title.scrollHeight}px`;
        };
        resize();
        let width = title.clientWidth;
        const observer = new ResizeObserver(() => {
            if (title.clientWidth === width) return;
            width = title.clientWidth;
            resize();
        });
        observer.observe(title);
        return () => observer.disconnect();
    }, [titleInput]);
    const [isEditing, setIsEditing] = useState(false);
    const autoFocusedNoteRef = useRef<string | null>(null);
    // Track pending title to prevent useEffect from reverting to old value
    const pendingTitleRef = useRef<string | null>(null);
    // Esc 还原时跳过随后 blur 触发的提交
    const escapeRevertRef = useRef(false);

    // ========== 根据模式选择数据源 ==========
    const noteId = isDstuMode ? dstuNoteId : contextActive?.id;
    const appearance = useNoteAppearance(noteId);
    const appearanceTitleId = useId();
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const appearanceTriggerRef = useRef<HTMLButtonElement>(null);
    const appearancePanelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!appearanceOpen) return;
        const frame = requestAnimationFrame(() => {
            const panel = appearancePanelRef.current;
            const selected = panel?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)');
            (selected ?? panel)?.focus();
        });
        return () => cancelAnimationFrame(frame);
    }, [appearanceOpen]);
    useEffect(() => { setAppearanceOpen(false); }, [noteId]);
    useEffect(() => {
        if (!autoFocusTitle || !noteId || readOnly || autoFocusedNoteRef.current === noteId) return;
        autoFocusedNoteRef.current = noteId;
        const frame = requestAnimationFrame(() => {
            const title = titleRef.current;
            if (!title || document.activeElement?.closest('.ProseMirror')) return;
            title.focus({ preventScroll: true });
            title.select();
        });
        return () => cancelAnimationFrame(frame);
    }, [autoFocusTitle, noteId, readOnly]);
    // 排版（小字号/全宽/字体）已移入页面 ▾ 菜单（Notion 同款），此处只管页面图标
    const appearanceLabel = t('notes:appearance.icon', { defaultValue: isZh ? '页面图标' : 'Page icon' });
    const iconLabels = [
        t('notes:appearance.icon_none', { defaultValue: isZh ? '无图标' : 'No icon' }),
        t('notes:appearance.icon_document', { defaultValue: isZh ? '文档' : 'Document' }),
        t('notes:appearance.icon_books', { defaultValue: isZh ? '书籍' : 'Books' }),
        t('notes:appearance.icon_idea', { defaultValue: isZh ? '灵感' : 'Idea' }),
        t('notes:appearance.icon_experiment', { defaultValue: isZh ? '实验' : 'Experiment' }),
        t('notes:appearance.icon_notes', { defaultValue: isZh ? '记录' : 'Notes' }),
    ];
    
    // Determine display title
    const displayTitle = isDstuMode ? (initialTitle || "") : (contextActive?.title || "");

    const titleDirtyRef = useRef(false);
    // C15：标题已在这轮编辑中被显式提交（保存并关闭）后同步置位，
    // 使聚合 dirty 复查在 displayTitle 尚未回流时也能立即读到“已提交”。
    const titleCommittedRef = useRef(false);
    // 保存挂点注册后长期存活，读取当前输入/标题需经 ref，避免闭包过期
    const titleInputValueRef = useRef(titleInput);
    titleInputValueRef.current = titleInput;
    const displayTitleValueRef = useRef(displayTitle);
    displayTitleValueRef.current = displayTitle;
    const trimmedInput = titleInput.trim();
    titleDirtyRef.current =
        !readOnly &&
        Boolean(noteId) &&
        Boolean(trimmedInput) &&
        trimmedInput !== (displayTitle || '').trim() &&
        (isEditing || pendingTitleRef.current !== null) &&
        !titleCommittedRef.current;

    useEffect(() => {
        if (!isDstuMode || !noteId || readOnly) return;
        return registerContentDirtyChecker('note', noteId, () => titleDirtyRef.current);
    }, [isDstuMode, noteId, readOnly]);

    // C15：未提交标题的显式提交契约。失败时向调用方抛出，让「保存并关闭」
    // 保持窗口与草稿；成功后同步把标题标记为已提交（不等 displayTitle 回流）。
    useEffect(() => {
        if (!isDstuMode || !noteId || readOnly) return;
        return registerContentSaveHandler('note', noteId, async () => {
            if (!titleDirtyRef.current) return;
            const trimmed = titleInputValueRef.current.trim();
            if (!trimmed) {
                titleCommittedRef.current = true;
                pendingTitleRef.current = null;
                setIsEditing(false);
                setTitleInput(displayTitleValueRef.current);
                return;
            }
            if (trimmed === (displayTitleValueRef.current || '').trim()) {
                titleCommittedRef.current = true;
                pendingTitleRef.current = null;
                return;
            }
            if (!dstuOnTitleChangeRef.current) return;
            // 成功即已提交；失败抛出 → saveContentNow 不放行关闭
            await dstuOnTitleChangeRef.current(trimmed);
            titleCommittedRef.current = true;
            pendingTitleRef.current = null;
            setIsEditing(false);
            setTitleInput(trimmed);
        });
    }, [isDstuMode, noteId, readOnly]);

    // Calculate Breadcrumbs（仅 Context 模式）
    const breadcrumbs = useMemo(() => {
        if (isDstuMode || !contextActive) return [];
        return getPathToNote(contextActive.id, folders as Record<string, { title: string; children: string[] }>, notes);
    }, [isDstuMode, contextActive, folders, notes]);

    // Only show breadcrumbs if not in root (length > 1 means it has parents)
    const showBreadcrumbs = breadcrumbs.length > 1;

    // isSaving 仅在此处做 deprecated 兼容映射，组件内部一律消费 saveStatus
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

    const handleTitleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (readOnly) return;
        // 新一轮编辑：清除上一轮“已提交”标记
        titleCommittedRef.current = false;
        // 输入侧就地清洗（折叠换行、去控制字符、500 字符截断），
        // 与后端 note_repo validate_title 限额一致；正常输入为恒等变换
        setTitleInput(sanitizeNoteTitleInput(e.target.value));
        setIsEditing(true);
    };

    const handleTitleSubmit = async () => {
        if (readOnly) return;
        if (escapeRevertRef.current) {
            // Esc 还原：不提交，状态已在 keydown 中回滚
            escapeRevertRef.current = false;
            return;
        }
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

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isComposingKeyEvent(e)) return;
        const atEnd = e.currentTarget.selectionStart === e.currentTarget.value.length
            && e.currentTarget.selectionEnd === e.currentTarget.value.length;
        if (e.key === 'Enter' || (e.key === 'ArrowDown' && atEnd && onExitToBody)) {
            // 标题与正文是同一份文档：Enter / ↓ 提交标题并把光标送进正文开头
            e.preventDefault();
            e.currentTarget.blur(); // Triggers onBlur -> handleTitleSubmit
            onExitToBody?.();
        } else if (e.key === 'Escape') {
            // Esc 还原为已保存标题并退出编辑（blur 提交由 escapeRevertRef 短路）
            e.preventDefault();
            escapeRevertRef.current = true;
            pendingTitleRef.current = null;
            setTitleInput(displayTitle);
            setIsEditing(false);
            e.currentTarget.blur();
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

    // ========== P1-10：内联标签行（chips + 内联展开输入，不用 Popover） ==========
    const effectiveTags = tagsProp ?? (isDstuMode ? [] : ((contextActive?.tags as string[] | undefined) ?? []));
    const commitTags = onTagsChange
        ?? (!isDstuMode && noteId && updateNoteTags
            ? (next: string[]) => updateNoteTags(noteId, next)
            : undefined);
    const canEditTags = !readOnly && Boolean(noteId) && Boolean(commitTags);
    const [tagInputOpen, setTagInputOpen] = useState(false);
    const [tagInput, setTagInput] = useState('');
    const [isSavingTags, setIsSavingTags] = useState(false);
    /** 标签前置校验的内联错误（超长 / 控制字符 / 数量达上限） */
    const [tagError, setTagError] = useState<string | null>(null);
    const tagInputRef = useRef<HTMLInputElement>(null);
    const tagTriggerRef = useRef<HTMLButtonElement>(null);
    const restoreTagFocusRef = useRef(false);
    const tagSuggestionsListId = useId();
    const tagErrorId = useId();

    // 既有标签自动补全（输入行打开时加载；建议浮层为轻量下拉）
    const {
        suggestions: tagSuggestions,
        isLoading: isLoadingTagSuggestions,
        highlightIndex: tagHighlightIndex,
        setHighlightIndex: setTagHighlightIndex,
        moveHighlight: moveTagHighlight,
        highlighted: highlightedTagSuggestion,
    } = useTagSuggestions({
        currentTags: effectiveTags,
        enabled: tagInputOpen && canEditTags,
        query: tagInput,
    });

    useEffect(() => {
        if (tagInputOpen) tagInputRef.current?.focus();
        else if (restoreTagFocusRef.current) {
            restoreTagFocusRef.current = false;
            tagTriggerRef.current?.focus({ preventScroll: true });
        }
    }, [tagInputOpen]);

    // 📱 Android 返回键：标签建议 listbox 打开时先收起输入行（同 Esc 路径），
    // 再轮到下层 overlay / 视图导航
    const tagSuggestionsVisible =
        canEditTags && tagInputOpen && (isLoadingTagSuggestions || tagSuggestions.length > 0);
    useEffect(() => {
        if (!tagSuggestionsVisible) return;
        return registerBackHandler(() => {
            // 保活守卫：编辑器 tab 在被隐藏的保活层里仍保持挂载（visibility:hidden），
            // 建议展开态也随之滞留——此时不消费返回键，交还给当前活跃视图
            const el = tagInputRef.current;
            if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
            if (window.getComputedStyle(el).visibility === 'hidden') return false;
            setTagInput('');
            setTagError(null);
            setTagInputOpen(false);
            return true;
        }, BACK_PRIORITY.overlay);
    }, [tagSuggestionsVisible]);

    const applyTags = async (next: string[]) => {
        if (!commitTags || isSavingTags) return;
        setIsSavingTags(true);
        try {
            await commitTags(next);
        } catch (error: unknown) {
            console.error('[NotesEditorHeader] Failed to update tags:', error);
            showGlobalNotification(
                'error',
                t('notes:notifications.tagStateSaveFailed', 'Failed to save tags'),
            );
        } finally {
            setIsSavingTags(false);
        }
    };

    const handleAddTag = async (value?: string) => {
        const normalized = (value ?? tagInput).trim();
        if (!normalized) {
            setTagError(null);
            setTagInputOpen(false);
            return;
        }
        // 前置校验（与后端 note_repo validate_tags 限额一致；后端 InvalidArgument 仍兜底）
        if (effectiveTags.length >= NOTE_TAGS_MAX_COUNT) {
            setTagError(t('notes:editorV2.tags_limit_reached', {
                defaultValue: 'You can add up to {{max}} tags',
                max: NOTE_TAGS_MAX_COUNT,
            }));
            return;
        }
        const violation = validateNoteTag(normalized);
        if (violation === 'too_long') {
            setTagError(t('notes:editorV2.tag_too_long', {
                defaultValue: 'Tags can be at most {{max}} characters',
                max: NOTE_TAG_MAX_CHARS,
            }));
            return;
        }
        if (violation === 'control_chars') {
            setTagError(t('notes:editorV2.tag_invalid_chars', 'Tags can\'t contain control characters'));
            return;
        }
        setTagError(null);
        if (effectiveTags.some((tag) => tag.toLowerCase() === normalized.toLowerCase())) {
            setTagInput('');
            return;
        }
        await applyTags([...effectiveTags, normalized]);
        setTagInput('');
        setTagHighlightIndex(-1);
    };

    const handleRemoveTag = (tag: string) => {
        void applyTags(effectiveTags.filter((item) => item !== tag));
    };

    if (!noteId) return null;

    const hasIcon = Boolean(appearance.value.icon);
    const showAddTagInline = canEditTags && effectiveTags.length === 0 && !tagInputOpen;

    return (
        <header className="notes-document-header group relative pt-10 pb-2" data-notes-preset={appearance.value.preset}
            data-notes-small-text={appearance.value.smallText ? 'true' : undefined}
            data-notes-full-width={appearance.value.fullWidth ? 'true' : undefined}
            data-notes-font={appearance.value.font}>
            {showBreadcrumbs && (
                <div className="mb-3 flex min-h-5 flex-wrap items-center">
                {/* Breadcrumbs (Left aligned) - Only show if nested in folders */}
                {showBreadcrumbs && (
                    <nav aria-label={t('notes:header.breadcrumbs', { defaultValue: isZh ? '笔记路径' : 'Note path' })} className="notes-document-breadcrumbs flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-xs text-muted-foreground select-none mr-auto">
                        {breadcrumbs.map((item, index) => {
                            const isCurrent = index === breadcrumbs.length - 1;
                            const icon = item.type === 'folder' ? (
                                <Folder className="h-3 w-3 opacity-70" aria-hidden="true" />
                            ) : (
                                <NoteGlyph noteId={item.id} size={12} fallback={<FileText className="h-3 w-3 opacity-70" aria-hidden="true" />} />
                            );
                            const label = (
                                <span className={`truncate ${item.type === 'folder' ? 'max-w-[100px]' : 'max-w-[150px]'}`}>
                                    {item.title}
                                </span>
                            );
                            return (
                                <React.Fragment key={item.id}>
                                    {index > 0 && <CaretRight className="h-3 w-3 shrink-0 opacity-40" aria-hidden="true" />}
                                    {isCurrent ? (
                                        <span
                                            className="flex min-w-0 items-center gap-1 text-foreground font-medium"
                                            aria-current="page"
                                            title={item.title}
                                        >
                                            {icon}
                                            {label}
                                        </span>
                                    ) : (
                                        <button
                                            type="button"
                                            className="flex min-w-0 items-center gap-1 rounded-sm py-1 text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                                            onClick={() => handleBreadcrumbClick(item)}
                                            title={item.title}
                                        >
                                            {icon}
                                            {label}
                                        </button>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </nav>
                )}

                </div>
            )}

            {/* Notion：图标在操作行之上，点击图标即可更换 */}
            {hasIcon && <button type="button" className="notes-document-icon"
                aria-label={t('notes:appearance.change_icon', { defaultValue: isZh ? '更换图标' : 'Change icon' })}
                disabled={appearance.loading || appearance.error === 'load'}
                onClick={() => setAppearanceOpen(true)}>
                <span aria-hidden="true">{appearance.value.icon}</span>
            </button>}
            {/* Notion 式页面操作行：平时隐身，悬停标题区或键盘聚焦时浮现；触屏常显 */}
            <div className="notes-document-affordances" data-has-icon={hasIcon || undefined}>
                <Popover open={appearanceOpen} onOpenChange={setAppearanceOpen}>
                    <PopoverTrigger asChild>
                        <button ref={appearanceTriggerRef} type="button" className="notes-document-affordance" aria-label={appearanceLabel} aria-haspopup="dialog" aria-controls={appearanceOpen ? `${appearanceTitleId}-panel` : undefined}>
                            <SlidersHorizontal size={14} aria-hidden="true" />
                            <span>{hasIcon
                                ? t('notes:appearance.change_icon', { defaultValue: isZh ? '更换图标' : 'Change icon' })
                                : t('notes:appearance.add_icon', { defaultValue: isZh ? '添加图标' : 'Add icon' })}</span>
                        </button>
                    </PopoverTrigger>
    <PopoverContent ref={appearancePanelRef} id={`${appearanceTitleId}-panel`} tabIndex={-1} align="end" className="notes-appearance-panel w-80 p-3" aria-labelledby={appearanceTitleId} aria-busy={appearance.saving}
                            onKeyDown={(event) => {
                                if (event.key !== 'Escape') return;
                                if (isComposingKeyEvent(event)) {
                                    // The shared Popover also listens on document. Leave
                                    // IME cancellation native, without closing that layer.
                                    event.stopPropagation();
                                    return;
                                }
                                event.preventDefault();
                                event.stopPropagation();
                                setAppearanceOpen(false);
                                appearanceTriggerRef.current?.focus();
                            }}>
                            <div className="mb-2 flex items-center justify-between">
                                <h3 id={appearanceTitleId} className="text-sm font-medium">{appearanceLabel}</h3>
                                    <DsButton variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={appearance.loading || appearance.error === 'load'} aria-disabled={appearance.saving}
                                        onClick={() => {
                                            const pool = ALL_NOTE_ICONS.filter((icon) => icon !== appearance.value.icon);
                                            void appearance.update({ icon: pool[Math.floor(Math.random() * pool.length)] });
                                        }}>
                                        {t('notes:appearance.icon_random', { defaultValue: isZh ? '随机' : 'Random' })}
                                    </DsButton>
                                </div>
                            <fieldset disabled={appearance.loading || appearance.error === 'load'}>
                                <legend className="sr-only">{appearanceLabel}</legend>
                                <div className="flex flex-wrap gap-1">
                                    {NOTE_APPEARANCE_ICONS.map((icon, index) => (
                                        <DsButton key={icon} variant="ghost" size="icon" iconOnly className="notes-appearance-option" aria-label={iconLabels[index]} title={iconLabels[index]} aria-pressed={appearance.value.icon === icon} aria-disabled={appearance.saving} onClick={() => void appearance.update({ icon })}>
                                            {icon ? <span aria-hidden="true">{icon}</span> : <X size={14} aria-hidden="true" />}
                                        </DsButton>
                                    ))}
                                </div>
                                <div className="notes-icon-grid mt-2 max-h-48 overflow-y-auto pr-1">
                                    {NOTE_ICON_GROUPS.map((group) => (
                                        <div key={group.key} role="group" aria-label={t(`notes:appearance.icon_group_${group.key}`, { defaultValue: group.key })} className="grid grid-cols-8 gap-0.5 py-1">
                                            {group.icons.map((icon) => (
                                                <button key={icon} type="button" className="notes-icon-option" aria-label={icon} aria-pressed={appearance.value.icon === icon} aria-disabled={appearance.saving} onClick={() => void appearance.update({ icon })}>
                                                    <span aria-hidden="true">{icon}</span>
                                                </button>
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            </fieldset>
                            {(appearance.loading || appearance.saving) && <p role="status" className="mt-2 text-xs text-muted-foreground">{appearance.loading ? t('common:loading') : t('notes:editor.save_status.saving')}</p>}
                            {appearance.error && <div role="alert" className="mt-2 text-xs text-destructive">
                                {appearance.error === 'load'
                                    ? t('notes:appearance.load_failed', { defaultValue: isZh ? '外观加载失败' : 'Could not load appearance' })
                                    : t('notes:appearance.save_failed', { defaultValue: isZh ? '外观未保存，请重新选择' : 'Appearance was not saved. Please select again.' })}
                                {appearance.error === 'load' && <DsButton variant="ghost" size="sm" onClick={() => void appearance.reload()}>{t('notes:editor.save_status.retry')}</DsButton>}
                            </div>}
                        </PopoverContent>
                </Popover>
                {showAddTagInline && (
                    <button
                        ref={tagTriggerRef}
                        type="button"
                        className="notes-document-affordance"
                        onClick={() => setTagInputOpen(true)}
                        aria-label={t('notes:header.add_tags')}
                    >
                        <TagIcon size={14} aria-hidden="true" />
                        <span>{t('notes:header.add_tags')}</span>
                    </button>
                )}
            </div>

            <textarea
                ref={titleRef}
                rows={1}
                className="notes-document-title w-full border-none bg-transparent p-0 font-semibold text-foreground shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
                aria-label={t('notes:header.documentTitle')}
                value={titleInput}
                onChange={readOnly ? undefined : handleTitleChange}
                onBlur={readOnly ? undefined : handleTitleSubmit}
                onKeyDown={readOnly ? undefined : handleKeyDown}
                placeholder={t('notes:common.untitled')}
                readOnly={readOnly}
            />

            {/* P1-10：标签 chips + 内联展开输入（触屏可达；桌面同样可用，不再依赖 lg 断点） */}
            {(effectiveTags.length > 0 || tagInputOpen) && (
                <div
                    className="notes-document-tags mt-2 flex flex-wrap items-center gap-1.5"
                    data-testid="notes-editor-tags"
                >
                    <TagIcon className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                    <AnimatePresence initial={false}>
                        {effectiveTags.map((tag) => (
                            <motion.span
                                key={tag}
                                layout
                                initial={{ opacity: 0, scale: 0.85 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.85 }}
                                transition={motionSafe(springSnap)}
                                className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 py-0.5 pl-2 pr-1 text-[11px] leading-none text-primary [@media(pointer:coarse)]:py-1.5"
                            >
                                <span className="max-w-[140px] truncate">{tag}</span>
                                {canEditTags ? (
                                    <button
                                        type="button"
                                        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-primary/60 transition-colors duration-150 hover:bg-primary/15 hover:text-primary [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                                        onClick={() => handleRemoveTag(tag)}
                                        disabled={isSavingTags}
                                        aria-label={t('notes:header.remove_tag')}
                                        title={t('notes:header.remove_tag')}
                                    >
                                        <X className="h-2.5 w-2.5" aria-hidden="true" />
                                    </button>
                                ) : (
                                    <span className="w-1" aria-hidden="true" />
                                )}
                            </motion.span>
                        ))}
                    </AnimatePresence>
                    {canEditTags && (tagInputOpen ? (
                        <span className="relative inline-flex">
                            <input
                                ref={tagInputRef}
                                value={tagInput}
                                onChange={(e) => {
                                    setTagInput(e.target.value);
                                    setTagError(null);
                                }}
                                onKeyDown={(e) => {
                                    if (isComposingKeyEvent(e)) return;
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void handleAddTag(highlightedTagSuggestion ?? undefined);
                                    } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        restoreTagFocusRef.current = true;
                                        setTagInput('');
                                        setTagError(null);
                                        setTagInputOpen(false);
                                    } else if (e.key === 'ArrowDown') {
                                        if (moveTagHighlight(1)) e.preventDefault();
                                    } else if (e.key === 'ArrowUp') {
                                        if (moveTagHighlight(-1)) e.preventDefault();
                                    }
                                }}
                                onBlur={() => {
                                    // 失焦提交已输入内容；为空则收起
                                    void handleAddTag();
                                }}
                                placeholder={t('notes:header.tag_placeholder')}
                                aria-label={t('notes:header.add_tags')}
                                disabled={isSavingTags}
                                role="combobox"
                                aria-expanded={tagSuggestions.length > 0}
                                aria-controls={tagSuggestionsListId}
                                aria-activedescendant={highlightedTagSuggestion
                                    ? `${tagSuggestionsListId}-${tagHighlightIndex}`
                                    : undefined}
                                aria-autocomplete="list"
                                aria-invalid={tagError ? true : undefined}
                                aria-describedby={tagError ? tagErrorId : undefined}
                                className="h-6 w-32 rounded-full border border-border/60 bg-transparent px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-[hsl(var(--ring))] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-40 [@media(pointer:coarse)]:text-base"
                            />
                            {(isLoadingTagSuggestions || tagSuggestions.length > 0) && (
                                // 定位交给外层普通 div：OverlayScrollbars 会给宿主强加 position:relative，
                                // 直接在 ScrollArea 上写 absolute 会失效，下拉掉回文档流把页头撑高
                                <div className="ui-rise-in absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-[var(--notes-radius-popup,12px)] border border-border bg-popover text-popover-foreground shadow-[var(--notes-popover-shadow,0_8px_24px_hsl(var(--shadow-base)/0.14))]">
                                <CustomScrollArea
                                    className="max-h-[220px]"
                                    viewportClassName="p-1"
                                    fullHeight={false}
                                >
                                    {isLoadingTagSuggestions ? (
                                        <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] text-muted-foreground">
                                            <CircleNotch className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                            {t('common:loading')}
                                        </div>
                                    ) : (
                                        <div
                                            id={tagSuggestionsListId}
                                            role="listbox"
                                            aria-label={t('notes:header.suggestions')}
                                            className="grid grid-cols-1 gap-0.5"
                                        >
                                            {tagSuggestions.map((tag, index) => (
                                                <div
                                                    key={tag}
                                                    id={`${tagSuggestionsListId}-${index}`}
                                                    role="option"
                                                    aria-selected={tagHighlightIndex === index}
                                                    className={cn(
                                                        'flex cursor-pointer items-center gap-1.5 truncate rounded-sm px-1.5 py-1 text-[11px] transition-colors duration-150 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-2.5',
                                                        tagHighlightIndex === index
                                                            ? 'bg-[var(--interactive-hover)] text-foreground'
                                                            : 'hover:bg-[var(--interactive-hover)]',
                                                    )}
                                                    onMouseDown={(e) => e.preventDefault()}
                                                    onClick={() => void handleAddTag(tag)}
                                                    onMouseEnter={() => setTagHighlightIndex(index)}
                                                >
                                                    <Plus className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                    <span className="truncate">{tag}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </CustomScrollArea>
                                </div>
                            )}
                        </span>
                    ) : (
                        <button
                            ref={tagTriggerRef}
                            type="button"
                            className="inline-flex h-6 items-center gap-0.5 rounded-full border border-dashed border-border/70 px-2 text-[11px] leading-none text-muted-foreground/70 transition-colors duration-150 hover:border-border hover:text-foreground [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-3"
                            onClick={() => setTagInputOpen(true)}
                            aria-label={t('notes:header.add_tags')}
                        >
                            <Plus className="h-3 w-3" aria-hidden="true" />
                            <span>{t('notes:header.add_tags')}</span>
                        </button>
                    ))}
                    {tagError && (
                        <span
                            id={tagErrorId}
                            role="alert"
                            className="w-full text-[11px] leading-snug text-destructive"
                        >
                            {tagError}
                        </span>
                    )}
                </div>
            )}

            {/* 冲突态：整行内联说明（避免挤在右侧元信息里被截断） */}
            {saveStatus === 'conflict' && (
                <div
                    className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-destructive"
                    role="status"
                    aria-live="polite"
                >
                    <WarningCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{statusLabel}</span>
                </div>
            )}
        </header>
    );
};
