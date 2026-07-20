import React, { useState, useEffect, useCallback, useMemo, useId } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { springSnap, motionSafe } from "@/styles/motion-springs";
import { X, Plus, Tag as TagIcon, CircleNotch, PencilSimple, Check } from "@phosphor-icons/react";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/shad/Popover";
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from "@/components/ui/shad/Input";
import { Badge } from "@/components/ui/shad/Badge";
import { NotesAPI } from "../../../utils/notesApi";
import { useNotes } from "../NotesContext";
import { showGlobalNotification } from "@/components/UnifiedNotification";
import { cn } from "../../../lib/utils";
import {
    NOTE_TAG_MAX_CHARS,
    NOTE_TAGS_MAX_COUNT,
    validateNoteTag,
} from "../noteInputLimits";

interface NoteTagsEditorProps {
    noteId: string;
    initialTags: string[];
    onTagsChange: (newTags: string[]) => Promise<void>;
    readonly?: boolean;
    variant?: 'popover' | 'inline';
}

const CHIP_HOVER_TRANSITION =
    "[transition:background-color_var(--notes-hover-transition,120ms_ease),color_var(--notes-hover-transition,120ms_ease),opacity_var(--notes-hover-transition,120ms_ease)] motion-reduce:transition-none";

export const NoteTagsEditor: React.FC<NoteTagsEditorProps> = ({
    noteId,
    initialTags,
    onTagsChange,
    readonly = false,
    variant = 'popover'
}) => {
    const { t } = useTranslation(['notes', 'common']);
    const { renameTagAcrossNotes } = useNotes();
    const isInline = variant === 'inline';
    const [open, setOpen] = useState(false);
    const [suggestionsOpen, setSuggestionsOpen] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const [availableTags, setAvailableTags] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [editingTag, setEditingTag] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [isRenaming, setIsRenaming] = useState(false);
    // 建议列表键盘高亮（-1 = 未进入列表，Enter 直接添加输入值）
    const [suggestionIndex, setSuggestionIndex] = useState(-1);
    const suggestionsListId = useId();
    /** 标签前置校验的内联错误（超长 / 控制字符 / 数量达上限） */
    const [inputError, setInputError] = useState<string | null>(null);
    const inputErrorId = useId();

    const hasTagConflict = useCallback(
        (candidate: string, excludeTag?: string) => {
            const lower = candidate.toLowerCase();
            return initialTags.some(
                tag => tag !== excludeTag && tag.toLowerCase() === lower
            );
        },
        [initialTags]
    );

    const loadAvailableTags = useCallback(async () => {
        setIsLoading(true);
        try {
            const tags = await NotesAPI.listTags();
            setAvailableTags(
                tags.filter(tag => !initialTags.some(existing => existing.toLowerCase() === tag.toLowerCase()))
            );
        } catch (error: unknown) {
            console.error("Failed to load tags", error);
            showGlobalNotification('error', t('notes:header.load_tags_failed'));
        } finally {
            setIsLoading(false);
        }
    }, [initialTags, t]);

    // Load available tags when popover opens
    useEffect(() => {
        if (isInline) return;
        if (open) {
            void loadAvailableTags();
        } else {
            setInputValue("");
            setSuggestionIndex(-1);
            setInputError(null);
            setEditingTag(null);
            setRenameValue("");
        }
    }, [isInline, open, loadAvailableTags]);

    // inline 模式：建议浮层打开时加载可用标签
    useEffect(() => {
        if (!isInline) return;
        if (suggestionsOpen) {
            void loadAvailableTags();
        } else {
            setSuggestionIndex(-1);
        }
    }, [isInline, suggestionsOpen, loadAvailableTags]);

    // 输入即时过滤建议
    const filteredSuggestions = useMemo(() => {
        const query = inputValue.trim().toLowerCase();
        return availableTags
            .filter(tag => !query || tag.toLowerCase().includes(query))
            .slice(0, 8);
    }, [availableTags, inputValue]);

    // 建议集合变化后收敛高亮
    useEffect(() => {
        setSuggestionIndex(prev => (prev >= filteredSuggestions.length ? -1 : prev));
    }, [filteredSuggestions]);

    const handleAddTag = async (tag: string) => {
        if (isSaving) return;
        const normalizedTag = tag.trim();
        if (!normalizedTag) {
            setInputValue("");
            setSuggestionIndex(-1);
            return;
        }
        // 前置校验（与后端 note_repo validate_tags 限额一致；后端 InvalidArgument 仍兜底）
        if (initialTags.length >= NOTE_TAGS_MAX_COUNT) {
            setInputError(t('notes:editorV2.tags_limit_reached', {
                defaultValue: 'You can add up to {{max}} tags',
                max: NOTE_TAGS_MAX_COUNT,
            }));
            return;
        }
        const violation = validateNoteTag(normalizedTag);
        if (violation === 'too_long') {
            setInputError(t('notes:editorV2.tag_too_long', {
                defaultValue: 'Tags can be at most {{max}} characters',
                max: NOTE_TAG_MAX_CHARS,
            }));
            return;
        }
        if (violation === 'control_chars') {
            setInputError(t('notes:editorV2.tag_invalid_chars', "Tags can't contain control characters"));
            return;
        }
        setInputError(null);
        if (hasTagConflict(normalizedTag)) {
            showGlobalNotification('warning', t('notes:header.tag_exists'));
            setInputValue("");
            setSuggestionIndex(-1);
            return;
        }

        setIsSaving(true);
        const newTags = [...initialTags, normalizedTag];
        try {
            await onTagsChange(newTags);
            setInputValue("");
            setSuggestionIndex(-1);
            // Update available tags list locally
            setAvailableTags(prev => prev.filter(t => t.toLowerCase() !== normalizedTag.toLowerCase()));
        } catch (error: unknown) {
            console.error("Failed to add tag", error);
            showGlobalNotification('error', t('notes:context.tag_add_failed'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemoveTag = async (tagToRemove: string) => {
        if (isSaving) return;
        setIsSaving(true);
        const newTags = initialTags.filter(t => t !== tagToRemove);
        try {
            await onTagsChange(newTags);
        } catch (error: unknown) {
            console.error("Failed to remove tag", error);
            showGlobalNotification('error', t('notes:context.tag_remove_failed'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        switch (e.key) {
            case 'Enter':
                e.preventDefault();
                if (suggestionIndex >= 0 && suggestionIndex < filteredSuggestions.length) {
                    void handleAddTag(filteredSuggestions[suggestionIndex]);
                } else {
                    void handleAddTag(inputValue);
                }
                break;
            case 'Escape':
                if (!isInline) break;
                if (suggestionsOpen) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSuggestionsOpen(false);
                } else if (inputValue) {
                    e.preventDefault();
                    setInputValue("");
                    setInputError(null);
                }
                break;
            case 'Backspace':
                if (isInline && inputValue === "" && initialTags.length > 0) {
                    e.preventDefault();
                    void handleRemoveTag(initialTags[initialTags.length - 1]);
                }
                break;
            case 'ArrowDown':
                if (filteredSuggestions.length > 0) {
                    e.preventDefault();
                    setSuggestionIndex(prev => (prev + 1) % filteredSuggestions.length);
                }
                break;
            case 'ArrowUp':
                if (filteredSuggestions.length > 0) {
                    e.preventDefault();
                    setSuggestionIndex(prev =>
                        prev <= 0 ? filteredSuggestions.length - 1 : prev - 1
                    );
                }
                break;
            default:
                break;
        }
    };

    const handleRenameTag = async () => {
        const normalizedNewName = renameValue.trim();
        const oldName = editingTag;

        if (!normalizedNewName || !oldName || oldName === normalizedNewName) {
            setEditingTag(null);
            setRenameValue("");
            return;
        }

        if (hasTagConflict(normalizedNewName, oldName)) {
            showGlobalNotification('warning', t('notes:header.tag_exists'));
            return;
        }

        // 重命名同样受单标签限额约束（chip 内联输入空间有限，走全局通知提示）
        const renameViolation = validateNoteTag(normalizedNewName);
        if (renameViolation === 'too_long') {
            showGlobalNotification('warning', t('notes:editorV2.tag_too_long', {
                defaultValue: 'Tags can be at most {{max}} characters',
                max: NOTE_TAG_MAX_CHARS,
            }));
            return;
        }
        if (renameViolation === 'control_chars') {
            showGlobalNotification('warning', t('notes:editorV2.tag_invalid_chars', "Tags can't contain control characters"));
            return;
        }

        setIsRenaming(true);
        try {
            // 更新当前笔记的标签
            const newTags = initialTags.map(tag => tag === oldName ? normalizedNewName : tag);
            await onTagsChange(newTags);

            // 批量更新所有笔记中的标签（跳过当前笔记）
            const updatedCount = await renameTagAcrossNotes(oldName, normalizedNewName, noteId);
            if (updatedCount > 0) {
                showGlobalNotification(
                    'success',
                    t('notes:header.rename_tag_success'),
                    t('notes:header.rename_tag_count', {
                        count: updatedCount,
                    })
                );
            }

            // 刷新标签列表
            void loadAvailableTags();

            setEditingTag(null);
            setRenameValue("");
        } catch (error: unknown) {
            console.error("Failed to rename tag", error);
            showGlobalNotification('error', t('notes:header.rename_failed'));
        } finally {
            setIsRenaming(false);
        }
    };

    const handleStartRename = (tag: string) => {
        setEditingTag(tag);
        setRenameValue(tag);
    };

    const handleCancelRename = () => {
        setEditingTag(null);
        setRenameValue("");
    };

    const suggestionsListbox = (
        <div
            id={suggestionsListId}
            role="listbox"
            aria-label={t('notes:header.suggestions')}
            className="grid grid-cols-1 gap-0.5"
        >
            {filteredSuggestions.map((tag, index) => (
                <div
                    key={tag}
                    id={`${suggestionsListId}-${index}`}
                    role="option"
                    aria-selected={suggestionIndex === index}
                    className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer text-xs",
                        CHIP_HOVER_TRANSITION,
                        suggestionIndex === index
                            ? "bg-[var(--interactive-hover)]"
                            : "hover:bg-[var(--interactive-hover)]"
                    )}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => void handleAddTag(tag)}
                    onMouseEnter={() => setSuggestionIndex(index)}
                >
                    <Plus className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    {tag}
                </div>
            ))}
        </div>
    );

    const comboboxExpanded = isInline
        ? suggestionsOpen && filteredSuggestions.length > 0
        : filteredSuggestions.length > 0;
    const activeDescendant =
        suggestionIndex >= 0 && suggestionIndex < filteredSuggestions.length
            ? `${suggestionsListId}-${suggestionIndex}`
            : undefined;

    if (isInline) {
        return (
            <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <AnimatePresence initial={false}>
                    {initialTags.map(tag => (
                        <motion.span
                            key={tag}
                            layout
                            initial={{ opacity: 0, scale: 0.85 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.85 }}
                            transition={motionSafe(springSnap)}
                            className={cn(
                                "inline-flex h-6 max-w-full items-center gap-1 rounded-[999px] bg-secondary px-2 text-xs text-secondary-foreground",
                                CHIP_HOVER_TRANSITION
                            )}
                        >
                            <span className="max-w-[160px] truncate">{tag}</span>
                            {!readonly && (
                                <button
                                    type="button"
                                    onClick={() => void handleRemoveTag(tag)}
                                    disabled={isSaving}
                                    className={cn(
                                        "rounded-full p-0.5 text-muted-foreground opacity-70 hover:opacity-100 hover:text-destructive focus-visible:opacity-100 disabled:opacity-40",
                                        CHIP_HOVER_TRANSITION
                                    )}
                                    aria-label={`${t('notes:header.remove_tag')}: ${tag}`}
                                >
                                    <X className="h-3 w-3" aria-hidden="true" />
                                </button>
                            )}
                        </motion.span>
                    ))}
                </AnimatePresence>
                {readonly && initialTags.length === 0 && (
                    <span className="text-xs text-muted-foreground/70 italic">
                        {t('notes:header.no_tags')}
                    </span>
                )}
                {!readonly && (
                    <input
                        value={inputValue}
                        onChange={e => {
                            setInputValue(e.target.value);
                            setInputError(null);
                            setSuggestionsOpen(true);
                        }}
                        onFocus={() => setSuggestionsOpen(true)}
                        onBlur={() => setSuggestionsOpen(false)}
                        onKeyDown={handleKeyDown}
                        placeholder={initialTags.length === 0 ? t('notes:header.add_tags') : ''}
                        className="h-6 min-w-[80px] flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
                        role="combobox"
                        aria-label={t('notes:header.tag_placeholder')}
                        aria-expanded={comboboxExpanded}
                        aria-controls={suggestionsListId}
                        aria-activedescendant={activeDescendant}
                        aria-autocomplete="list"
                        aria-invalid={inputError ? true : undefined}
                        aria-describedby={inputError ? inputErrorId : undefined}
                    />
                )}
                {isSaving && (
                    <CircleNotch className="h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
                )}
                {!readonly && inputError && (
                    <span
                        id={inputErrorId}
                        role="alert"
                        className="w-full text-[11px] leading-snug text-destructive"
                    >
                        {inputError}
                    </span>
                )}
                {!readonly && suggestionsOpen && (isLoading || filteredSuggestions.length > 0) && (
                    <div className="ui-rise-in absolute left-0 top-full z-50 mt-1 max-h-[180px] w-full min-w-[220px] overflow-y-auto rounded-[var(--notes-radius-popup,12px)] border border-border bg-popover p-1.5 text-popover-foreground shadow-lg">
                        {isLoading ? (
                            <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                                <CircleNotch className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                {t('common:loading')}
                            </div>
                        ) : (
                            <>
                                <div className="text-[10px] text-muted-foreground mb-1 px-1">{t('notes:header.suggestions')}</div>
                                {suggestionsListbox}
                            </>
                        )}
                    </div>
                )}
            </div>
        );
    }

    return (
        <Popover open={open} onOpenChange={readonly ? undefined : setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    disabled={readonly}
                    className={cn(
                        "flex items-center gap-1 rounded-md px-2 py-1 -ml-2 text-left transition-colors duration-150 ease-[var(--dropdown-ease)] motion-reduce:transition-none",
                        readonly
                            ? "opacity-70 cursor-default"
                            : "hover:bg-[var(--interactive-hover)] cursor-pointer"
                    )}
                    aria-label={t('notes:header.manage_tags')}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                >
                    <TagIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    {initialTags.length > 0 ? (
                        <span className="flex min-w-0 flex-wrap items-center gap-1">
                            {initialTags.map(tag => (
                                <span key={tag} className="rounded-[999px] bg-primary/10 px-1.5 text-[10px] text-primary">
                                    {tag}
                                </span>
                            ))}
                        </span>
                    ) : (
                        <span className="text-[10px] text-muted-foreground/70">
                            {t('notes:header.add_tags')}
                        </span>
                    )}
                </button>
            </PopoverTrigger>
            {!readonly && (
                <PopoverContent className="w-80 rounded-[var(--notes-radius-popup,12px)] p-3" align="start">
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                            <TagIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            <span className="text-sm font-medium">{t('notes:header.tags')}</span>
                            {isSaving && <CircleNotch className="h-3 w-3 animate-spin ml-auto text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />}
                        </div>

                        {/* Current Tags */}
                        <div className="flex flex-wrap gap-1.5 min-h-[24px]">
                            {initialTags.length === 0 && (
                                <span className="text-xs text-muted-foreground italic">{t('notes:header.no_tags')}</span>
                            )}
                            {initialTags.map(tag => (
                                <Badge
                                    key={tag}
                                    variant="secondary"
                                    className={cn(
                                        "h-6 rounded-[999px] px-2 text-xs gap-1 group cursor-default",
                                        CHIP_HOVER_TRANSITION
                                    )}
                                >
                                    {editingTag === tag ? (
                                        <div className="flex items-center gap-1">
                                            <Input
                                                value={renameValue}
                                                onChange={e => setRenameValue(e.target.value)}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') handleRenameTag();
                                                    if (e.key === 'Escape') handleCancelRename();
                                                }}
                                                className="h-5 text-[10px] px-1 py-0 w-24"
                                                aria-label={t('notes:header.rename_tag')}
                                                autoFocus
                                            />
                                            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRenameTag} disabled={isRenaming} className="!h-auto !w-auto !p-0 opacity-70 hover:opacity-100 disabled:opacity-50" aria-label={t('notes:header.confirm_rename')}>
                                                <Check className="h-3 w-3" aria-hidden="true" />
                                            </NotionButton>
                                            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCancelRename} disabled={isRenaming} className="!h-auto !w-auto !p-0 opacity-70 hover:opacity-100 disabled:opacity-50" aria-label={t('notes:header.cancel_rename')}>
                                                <X className="h-3 w-3" aria-hidden="true" />
                                            </NotionButton>
                                        </div>
                                    ) : (
                                        <>
                                            <span onDoubleClick={() => handleStartRename(tag)}>{tag}</span>
                                            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleStartRename(tag)} className="!h-auto !w-auto !p-0 opacity-0 group-hover:opacity-70 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-70 hover:opacity-100 transition-opacity motion-reduce:transition-none" title={t('notes:header.rename_tag')} aria-label={`${t('notes:header.rename_tag')}: ${tag}`}>
                                                <PencilSimple className="h-3 w-3" aria-hidden="true" />
                                            </NotionButton>
                                            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleRemoveTag(tag)} className="!h-auto !w-auto !p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-70 hover:text-destructive transition-opacity motion-reduce:transition-none" title={t('notes:header.remove_tag')} aria-label={`${t('notes:header.remove_tag')}: ${tag}`}>
                                                <X className="h-3 w-3" aria-hidden="true" />
                                            </NotionButton>
                                        </>
                                    )}
                                </Badge>
                            ))}
                        </div>

                        <div className="space-y-2 pt-2">
                            <Input
                                placeholder={t('notes:header.tag_placeholder')}
                                value={inputValue}
                                onChange={e => {
                                    setInputValue(e.target.value);
                                    setInputError(null);
                                }}
                                onKeyDown={handleKeyDown}
                                className="h-8 text-xs"
                                role="combobox"
                                aria-expanded={comboboxExpanded}
                                aria-controls={suggestionsListId}
                                aria-activedescendant={activeDescendant}
                                aria-autocomplete="list"
                                aria-invalid={inputError ? true : undefined}
                                aria-describedby={inputError ? inputErrorId : undefined}
                            />
                            {inputError && (
                                <p
                                    id={inputErrorId}
                                    role="alert"
                                    className="m-0 text-[11px] leading-snug text-destructive"
                                >
                                    {inputError}
                                </p>
                            )}

                            {/* Suggestions */}
                            {isLoading ? (
                                <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                                    <CircleNotch className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                    {t('common:loading')}
                                </div>
                            ) : filteredSuggestions.length > 0 && (
                                <div className="border border-border rounded-[var(--notes-radius-popup,12px)] max-h-[150px] overflow-y-auto">
                                    <div className="p-1.5">
                                        <div className="text-[10px] text-muted-foreground mb-1 px-1">{t('notes:header.suggestions')}</div>
                                        {suggestionsListbox}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </PopoverContent>
            )}
        </Popover>
    );
};
