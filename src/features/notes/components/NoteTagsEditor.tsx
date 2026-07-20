import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
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

interface NoteTagsEditorProps {
    noteId: string;
    initialTags: string[];
    onTagsChange: (newTags: string[]) => Promise<void>;
    readonly?: boolean;
}

export const NoteTagsEditor: React.FC<NoteTagsEditorProps> = ({
    noteId,
    initialTags,
    onTagsChange,
    readonly = false
}) => {
    const { t } = useTranslation(['notes', 'common']);
    const { renameTagAcrossNotes } = useNotes();
    const [open, setOpen] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const [availableTags, setAvailableTags] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [editingTag, setEditingTag] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [isRenaming, setIsRenaming] = useState(false);
    // 建议列表键盘高亮（-1 = 未进入列表，Enter 直接添加输入值）
    const [suggestionIndex, setSuggestionIndex] = useState(-1);
    const suggestionsListId = useRef(`note-tags-suggestions-${Math.random().toString(36).slice(2, 9)}`).current;

    const loadAvailableTags = useCallback(async () => {
        setIsLoading(true);
        try {
            const tags = await NotesAPI.listTags();
            setAvailableTags(tags.filter(tag => !initialTags.includes(tag)));
        } catch (error: unknown) {
            console.error("Failed to load tags", error);
            showGlobalNotification('error', t('notes:header.load_tags_failed'));
        } finally {
            setIsLoading(false);
        }
    }, [initialTags, t]);

    // Load available tags when popover opens
    useEffect(() => {
        if (open) {
            void loadAvailableTags();
        } else {
            setInputValue("");
            setSuggestionIndex(-1);
            setEditingTag(null);
            setRenameValue("");
        }
    }, [open, loadAvailableTags]);

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
        const normalizedTag = tag.trim();
        if (!normalizedTag || initialTags.includes(normalizedTag)) {
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
            setAvailableTags(prev => prev.filter(t => t !== normalizedTag));
        } catch (error: unknown) {
            console.error("Failed to add tag", error);
            showGlobalNotification('error', t('notes:context.tag_add_failed'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemoveTag = async (tagToRemove: string) => {
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

        if (initialTags.includes(normalizedNewName)) {
            showGlobalNotification('warning', t('notes:header.tag_exists'));
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

    return (
        <Popover open={open} onOpenChange={readonly ? undefined : setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    disabled={readonly}
                    className={cn(
                        "flex items-center gap-1 rounded-md px-2 py-1 -ml-2 text-left transition-colors duration-150",
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
                                <span key={tag} className="rounded-sm bg-primary/10 px-1 text-[10px] text-primary">
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
                <PopoverContent className="w-80 p-3" align="start">
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                            <TagIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            <span className="text-sm font-medium">{t('notes:header.tags')}</span>
                            {isSaving && <CircleNotch className="h-3 w-3 animate-spin ml-auto text-muted-foreground" aria-hidden="true" />}
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
                                    className="h-6 px-1.5 text-xs gap-1 transition-colors duration-150 group cursor-default"
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
                                            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleStartRename(tag)} className="!h-auto !w-auto !p-0 opacity-0 group-hover:opacity-70 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-70 hover:opacity-100 transition-opacity" title={t('notes:header.rename_tag')} aria-label={`${t('notes:header.rename_tag')}: ${tag}`}>
                                                <PencilSimple className="h-3 w-3" aria-hidden="true" />
                                            </NotionButton>
                                            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleRemoveTag(tag)} className="!h-auto !w-auto !p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-70 hover:text-destructive transition-opacity" title={t('notes:header.remove_tag')} aria-label={`${t('notes:header.remove_tag')}: ${tag}`}>
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
                                onChange={e => setInputValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                className="h-8 text-xs"
                                role="combobox"
                                aria-expanded={filteredSuggestions.length > 0}
                                aria-controls={suggestionsListId}
                                aria-activedescendant={
                                    suggestionIndex >= 0 && suggestionIndex < filteredSuggestions.length
                                        ? `${suggestionsListId}-${suggestionIndex}`
                                        : undefined
                                }
                                aria-autocomplete="list"
                            />

                            {/* Suggestions */}
                            {isLoading ? (
                                <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                                    <CircleNotch className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    {t('common:loading')}
                                </div>
                            ) : filteredSuggestions.length > 0 && (
                                <div className="border rounded-md max-h-[150px] overflow-y-auto">
                                    <div className="p-1.5">
                                        <div className="text-[10px] text-muted-foreground mb-1 px-1">{t('notes:header.suggestions')}</div>
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
                                                        "flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer text-xs transition-colors duration-150",
                                                        suggestionIndex === index
                                                            ? "bg-[var(--interactive-hover)]"
                                                            : "hover:bg-[var(--interactive-hover)]"
                                                    )}
                                                    onClick={() => handleAddTag(tag)}
                                                    onMouseEnter={() => setSuggestionIndex(index)}
                                                >
                                                    <Plus className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                                                    {tag}
                                                </div>
                                            ))}
                                        </div>
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
