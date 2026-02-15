import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X, Plus, Tag as TagIcon, Loader2, Edit2, Check, AlertCircle } from "lucide-react";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "../../ui/shad/Popover";
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from "../../ui/shad/Input";
import { Badge } from "../../ui/shad/Badge";
import { Command, CommandGroup, CommandItem, CommandList } from "../../ui/shad/Command";
import { NotesAPI } from "../../../utils/notesApi";
import { useNotes } from "../NotesContext";
import { showGlobalNotification } from "../../UnifiedNotification";
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
        }
    }, [open, loadAvailableTags]);

    const handleAddTag = async (tag: string) => {
        const normalizedTag = tag.trim();
        if (!normalizedTag || initialTags.includes(normalizedTag)) {
            setInputValue("");
            return;
        }

        setIsSaving(true);
        const newTags = [...initialTags, normalizedTag];
        try {
            await onTagsChange(newTags);
            setInputValue("");
            // Update available tags list locally
            setAvailableTags(prev => prev.filter(t => t !== normalizedTag));
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemoveTag = async (tagToRemove: string) => {
        setIsSaving(true);
        const newTags = initialTags.filter(t => t !== tagToRemove);
        try {
            await onTagsChange(newTags);
            // Add back to available if it was a known tag? 
            // For simplicity we just reload or let it be.
        } finally {
            setIsSaving(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAddTag(inputValue);
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
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <div 
                    className={cn(
                        "flex items-center gap-1 transition-colors rounded-md px-2 py-1 -ml-2",
                        readonly ? "opacity-70 cursor-default" : "hover:bg-muted cursor-pointer"
                    )}
                    role="button"
                    aria-label={t('notes:header.manage_tags')}
                >
                    <TagIcon className="h-3 w-3 text-muted-foreground" />
                    {initialTags.length > 0 ? (
                        <div className="flex gap-1 flex-wrap max-w-[200px] overflow-hidden h-5">
                            {initialTags.map(tag => (
                                <span key={tag} className="text-[10px] bg-primary/10 text-primary px-1 rounded-sm whitespace-nowrap">
                                    {tag}
                                </span>
                            ))}
                        </div>
                    ) : (
                        <span className="text-[10px] text-muted-foreground/70">
                            {t('notes:header.add_tags')}
                        </span>
                    )}
                </div>
            </PopoverTrigger>
            {!readonly && (
                <PopoverContent className="w-80 p-3" align="start">
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                            <TagIcon className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">{t('notes:header.tags')}</span>
                            {isSaving && <Loader2 className="h-3 w-3 animate-spin ml-auto text-muted-foreground" />}
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
                                    className="h-6 px-1.5 text-xs gap-1 hover:bg-destructive/10 hover:text-destructive transition-colors group cursor-default"
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
                                                autoFocus
                                            />
                                            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRenameTag} disabled={isRenaming} className="!h-auto !w-auto !p-0 opacity-70 hover:opacity-100 disabled:opacity-50" aria-label="confirm">
                                                <Check className="h-3 w-3" />
                                            </NotionButton>
                                            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCancelRename} disabled={isRenaming} className="!h-auto !w-auto !p-0 opacity-70 hover:opacity-100 disabled:opacity-50" aria-label="cancel">
                                                <X className="h-3 w-3" />
                                            </NotionButton>
                                        </div>
                                    ) : (
                                        <>
                                            <span onClick={() => !readonly && handleStartRename(tag)} className="cursor-pointer">{tag}</span>
                                            {!readonly && (
                                                <>
                                                    <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleStartRename(tag)} className="!h-auto !w-auto !p-0 opacity-0 group-hover:opacity-70 hover:opacity-100 transition-opacity" title={t('notes:header.rename_tag')} aria-label="rename">
                                                        <Edit2 className="h-3 w-3" />
                                                    </NotionButton>
                                                    <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleRemoveTag(tag)} className="!h-auto !w-auto !p-0 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity" title={t('notes:header.remove_tag')} aria-label="remove">
                                                        <X className="h-3 w-3" />
                                                    </NotionButton>
                                                </>
                                            )}
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
                            />
                            
                            {/* Suggestions */}
                            {availableTags.length > 0 && (
                                <div className="border rounded-md max-h-[150px] overflow-y-auto">
                                    <div className="p-1.5">
                                        <div className="text-[10px] text-muted-foreground mb-1 px-1">{t('notes:header.suggestions')}</div>
                                        <div className="grid grid-cols-1 gap-0.5">
                                            {availableTags
                                                .filter(t => t.toLowerCase().includes(inputValue.toLowerCase()))
                                                .slice(0, 8) // Limit suggestions
                                                .map(tag => (
                                                <div 
                                                    key={tag}
                                                    className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded-sm cursor-pointer text-xs"
                                                    onClick={() => handleAddTag(tag)}
                                                >
                                                    <Plus className="h-3 w-3 text-muted-foreground" />
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
