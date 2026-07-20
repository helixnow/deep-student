import React, { useState, useEffect, useMemo, useRef, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useNotesOptional } from '../NotesContext';
import { getPathToNote, estimateReadingMinutes, type NoteContentStats } from '../notesUtils';
import { CaretRight, Check, CircleNotch, Folder, FileText, WarningCircle, Tag as TagIcon, X, Plus } from '@phosphor-icons/react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { Input } from '@/components/ui/shad/Input';
import { registerContentDirtyChecker } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { cn } from '@/lib/utils';
import { springSnap, motionSafe } from '@/styles/motion-springs';
import { useTagSuggestions } from '../hooks/useTagSuggestions';
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
}) => {
    const { t, i18n } = useTranslation(['notes', 'common']);
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
    const [isEditing, setIsEditing] = useState(false);
    // Track pending title to prevent useEffect from reverting to old value
    const pendingTitleRef = useRef<string | null>(null);
    // Esc 还原时跳过随后 blur 触发的提交
    const escapeRevertRef = useRef(false);

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

    const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (readOnly) return;
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

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.currentTarget.blur(); // Triggers onBlur -> handleTitleSubmit
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

    // 状态点颜色（.notes-save-status-dot 用 currentcolor 填充，这里按五态给 token 色）
    const statusDotClassName = (() => {
        switch (saveStatus) {
            case 'saved':
                return 'text-[hsl(var(--success))]';
            case 'saving':
                return 'text-[hsl(var(--info))]';
            case 'unsaved':
                return 'text-[hsl(var(--warning))]';
            case 'failed':
            case 'conflict':
            default:
                return 'text-destructive';
        }
    })();

    // 仅 transient 失败提供重试。冲突时外部版本通常已胜出，盲目 flush 会再次撞锁；
    // 恢复入口在 NoteContentView 的冲突通知「恢复我的版本」。
    const showRetry =
        !readOnly &&
        !!onRetrySave &&
        saveStatus === 'failed';

    // ========== 文档统计（字数 / 词数 / 阅读时间） ==========
    // stats 未接线时回退 charCount：词数未知，阅读时间按字符数近似（同 300/分口径）。
    const displayCharCount = stats?.charCount ?? charCount;
    const readingMinutes = stats
        ? stats.readingMinutes
        : estimateReadingMinutes(charCount ?? 0);
    const showStats = typeof displayCharCount === 'number' && displayCharCount > 0;
    const statsRows: Array<{ key: string; label: string; value: string }> = showStats
        ? [
            {
                key: 'chars',
                label: t('notes:editor.stats.chars_label', { defaultValue: isZh ? '字数' : 'Characters' }),
                value: String(displayCharCount),
            },
            ...(stats
                ? [{
                    key: 'words',
                    label: t('notes:editor.stats.words_label', { defaultValue: isZh ? '词数' : 'Words' }),
                    value: String(stats.wordCount),
                }]
                : []),
            {
                key: 'reading',
                label: t('notes:editor.stats.reading_label', { defaultValue: isZh ? '阅读时间' : 'Reading time' }),
                value: t('notes:editor.stats.reading_value', {
                    defaultValue: isZh ? '约 {{minutes}} 分钟' : '~{{minutes}} min',
                    minutes: readingMinutes,
                }),
            },
        ]
        : [];

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
    }, [tagInputOpen]);

    const applyTags = async (next: string[]) => {
        if (!commitTags || isSavingTags) return;
        setIsSavingTags(true);
        try {
            await commitTags(next);
        } catch (error: unknown) {
            console.error('[NotesEditorHeader] Failed to update tags:', error);
            showGlobalNotification('error', t('notes:header.tags_save_failed', '标签保存失败'));
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
                    <nav className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60 overflow-hidden whitespace-nowrap mask-linear-fade select-none mr-auto">
                        {breadcrumbs.map((item, index) => {
                            const isCurrent = index === breadcrumbs.length - 1;
                            const icon = item.type === 'folder' ? (
                                <Folder className="h-3 w-3 opacity-70" aria-hidden="true" />
                            ) : (
                                <FileText className="h-3 w-3 opacity-70" aria-hidden="true" />
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
                                            className="flex items-center gap-1 text-foreground/70 font-medium"
                                            aria-current="page"
                                        >
                                            {icon}
                                            {label}
                                        </span>
                                    ) : (
                                        <button
                                            type="button"
                                            className="flex items-center gap-1 rounded-sm text-muted-foreground/60 hover:text-foreground/80 transition-colors duration-150 cursor-pointer"
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

                {/* Save status & word count (Right aligned) */}
                <div
                    className={`notes-document-meta shrink-0 ${showBreadcrumbs ? 'ml-auto' : 'ml-0'} flex items-center gap-2 text-[11px] ${saveStatus === 'saved' ? 'notes-document-meta-saved' : ''}`}
                    aria-live="polite"
                >
                    {showStats && (
                        <span className="notes-doc-stats">
                            <span
                                className="notes-doc-stats-trigger text-muted-foreground/60 tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]"
                                tabIndex={0}
                                aria-label={statsRows.map((row) => `${row.label} ${row.value}`).join(', ')}
                            >
                                {t('notes:common.char_count', { count: displayCharCount })}
                                {saveStatus !== 'conflict' && (
                                    <span className="ml-2 opacity-50 select-none" aria-hidden="true">·</span>
                                )}
                            </span>
                            <dl className="notes-doc-stats-detail" aria-hidden="true">
                                {statsRows.map((row) => (
                                    <div key={row.key} className="notes-doc-stats-row">
                                        <dt>{row.label}</dt>
                                        <dd>{row.value}</dd>
                                    </div>
                                ))}
                            </dl>
                        </span>
                    )}
                    {saveStatus !== 'conflict' && (
                        <span className={`inline-flex items-center gap-1.5 ${statusClassName}`}>
                            {saveStatus === 'saved' ? (
                                <span className="notes-save-status-check" aria-hidden="true">
                                    <Check className="h-3 w-3" weight="bold" />
                                </span>
                            ) : saveStatus === 'failed' ? (
                                <span className="notes-save-status-warn" aria-hidden="true">
                                    <WarningCircle className="h-3 w-3" weight="bold" />
                                </span>
                            ) : (
                                <span className={`notes-save-status-dot ${statusDotClassName}`} data-status={saveStatus} aria-hidden="true" />
                            )}
                            <span>{statusLabel}</span>
                            {showRetry && (
                                <button
                                    type="button"
                                    className="underline underline-offset-2 hover:text-destructive/90 transition-colors duration-150"
                                    onClick={() => {
                                        void onRetrySave?.();
                                    }}
                                >
                                    {t('notes:editor.save_status.retry')}
                                </button>
                            )}
                        </span>
                    )}
                </div>
            </div>

            {/* P1-10：标签 chips + 内联展开输入（触屏可达；桌面同样可用，不再依赖 lg 断点） */}
            {(effectiveTags.length > 0 || canEditTags) && (
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
                                        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-primary/60 transition-colors duration-150 hover:bg-primary/15 hover:text-primary [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
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
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void handleAddTag(highlightedTagSuggestion ?? undefined);
                                    } else if (e.key === 'Escape') {
                                        e.preventDefault();
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
                                className="h-6 w-32 rounded-full border border-border/60 bg-transparent px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-[hsl(var(--ring))] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-40"
                            />
                            {(isLoadingTagSuggestions || tagSuggestions.length > 0) && (
                                <div className="ui-rise-in absolute left-0 top-full z-30 mt-1 max-h-[176px] w-44 overflow-y-auto rounded-[var(--notes-radius-popup,12px)] border border-border bg-popover p-1 text-popover-foreground shadow-[var(--notes-popover-shadow,0_8px_24px_hsl(var(--shadow-base)/0.14))]">
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
                                                        'flex cursor-pointer items-center gap-1.5 truncate rounded-sm px-1.5 py-1 text-[11px] transition-colors duration-150 motion-reduce:transition-none',
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
                                </div>
                            )}
                        </span>
                    ) : (
                        <button
                            type="button"
                            className="inline-flex h-6 items-center gap-0.5 rounded-full border border-dashed border-border/70 px-2 text-[11px] leading-none text-muted-foreground/70 transition-colors duration-150 hover:border-border hover:text-foreground [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:px-3"
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
