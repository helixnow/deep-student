import React, { useCallback, useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, Filter, Tag as TagIcon } from "lucide-react";
import { Input } from "../../ui/shad/Input";
import { NotionButton } from '@/components/ui/NotionButton';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "../../ui/shad/Popover";
import { Badge } from "../../ui/shad/Badge";
import { useNotes } from "../NotesContext";
import { NotesAPI } from "../../../utils/notesApi";
import { useDebounce } from "../../../hooks/useDebounce";
import { showGlobalNotification } from "../../UnifiedNotification";

export const NotesSidebarSearch: React.FC = () => {
    const { t } = useTranslation(['notes', 'common']);
    const { performSearch, setSearchQuery, searchQuery } = useNotes();
    const [localTerm, setLocalTerm] = useState(searchQuery);
    const debouncedTerm = useDebounce(localTerm, 500);
    const inputRef = useRef<HTMLInputElement>(null);
    const [highlight, setHighlight] = useState(false);
    const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 标签过滤相关状态
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [availableTags, setAvailableTags] = useState<string[]>([]);
    const [showTagFilter, setShowTagFilter] = useState(false);
    const [isLoadingTags, setIsLoadingTags] = useState(false);
    const [isLoadError, setIsLoadError] = useState(false);

    // 加载可用标签
    const loadTags = useCallback(() => {
        setIsLoadingTags(true);
        setIsLoadError(false);
        NotesAPI.listTags()
            .then(tags => setAvailableTags(tags))
            .catch(error => {
                console.error("Failed to load tags", error);
                setIsLoadError(true);
                showGlobalNotification('error', t('notes:errors.load_tags_failed', '标签加载失败，请刷新重试'));
            })
            .finally(() => setIsLoadingTags(false));
    }, [t]);

    useEffect(() => {
        loadTags();
    }, [loadTags]);

    // 搜索逻辑增强：支持标签过滤
    const executeSearch = useCallback((term: string, tags: string[]) => {
        performSearch(term, tags);
    }, [performSearch]);

    // 处理标签切换
    const toggleTag = useCallback((tag: string) => {
        setSelectedTags(prev => {
            const newTags = prev.includes(tag)
                ? prev.filter(t => t !== tag)
                : [...prev, tag];
            return newTags;
        });
    }, []);

    React.useEffect(() => {
        // Sync local term if external query changes (e.g. cleared)
        setLocalTerm(searchQuery);
    }, [searchQuery]);

    React.useEffect(() => {
        setSearchQuery(debouncedTerm);
        executeSearch(debouncedTerm, selectedTags);
    }, [debouncedTerm, selectedTags, executeSearch, setSearchQuery]);

    const handleClear = useCallback(() => {
        setLocalTerm("");
        setSearchQuery("");
        setSelectedTags([]);
        executeSearch("", []);
    }, [executeSearch]);

    React.useEffect(() => {
        const handleFocusRequest = () => {
            try {
                inputRef.current?.focus();
                inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                setHighlight(true);
                if (highlightTimer.current) {
                    clearTimeout(highlightTimer.current);
                }
                highlightTimer.current = setTimeout(() => setHighlight(false), 1200);
            } catch {}
        };
        window.addEventListener("notes:focus-sidebar-search", handleFocusRequest);
        return () => {
            window.removeEventListener("notes:focus-sidebar-search", handleFocusRequest);
            if (highlightTimer.current) clearTimeout(highlightTimer.current);
        };
    }, []);

    return (
        <div className="space-y-2">
            {/* 搜索输入框 */}
            <div className="relative px-0 group">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
                <Input
                    ref={inputRef}
                    className={`h-8 pl-8 pr-8 text-xs bg-background/50 border-transparent hover:bg-background focus:bg-background focus:border-border/50 focus:ring-0 transition-all placeholder:text-muted-foreground/40 shadow-sm ${highlight ? 'ring-2 ring-primary/60 ring-offset-1' : ''}`}
                    data-highlight={highlight ? "true" : "false"}
                    placeholder={t('notes:sidebar.search.search_placeholder')}
                    value={localTerm}
                    onChange={(e) => setLocalTerm(e.target.value)}
                />
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {/* 标签过滤器按钮 */}
                    <Popover open={showTagFilter} onOpenChange={setShowTagFilter}>
                        <PopoverTrigger asChild>
                            <NotionButton
                                variant="ghost"
                                size="icon"
                                className={`h-6 w-6 ${selectedTags.length > 0 ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                                title={t('notes:sidebar.search.filter_by_tag', 'Filter by tags')}
                            >
                                <Filter className="h-3.5 w-3.5" />
                                {selectedTags.length > 0 && (
                                    <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                                        {selectedTags.length}
                                    </Badge>
                                )}
                            </NotionButton>
                        </PopoverTrigger>
                        <PopoverContent className="w-64 p-2" align="end">
                            <div className="space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                    {t('notes:sidebar.search.filter_by_tag', 'Filter by tags')}
                                </div>
                                {isLoadingTags ? (
                                    <div className="text-xs text-muted-foreground/60 italic">
                                        {t('notes:sidebar.search.loading_tags', 'Loading tags...')}
                                    </div>
                                ) : isLoadError ? (
                                    <div className="flex flex-col items-center gap-1.5 py-2">
                                        <div className="text-xs text-destructive/80">
                                            {t('notes:errors.load_tags_failed', '标签加载失败，请刷新重试')}
                                        </div>
                                        <NotionButton
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 text-xs"
                                            onClick={loadTags}
                                        >
                                            {t('common:retry', '重试')}
                                        </NotionButton>
                                    </div>
                                ) : availableTags.length > 0 ? (
                                    <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                                        {availableTags.map(tag => (
                                            <Badge
                                                key={tag}
                                                variant={selectedTags.includes(tag) ? "default" : "outline"}
                                                className="text-[10px] cursor-pointer hover:bg-primary/10"
                                                onClick={() => toggleTag(tag)}
                                            >
                                                <TagIcon className="h-2.5 w-2.5 mr-1" />
                                                {tag}
                                                {selectedTags.includes(tag) && (
                                                    <X className="h-2.5 w-2.5 ml-1 opacity-70" />
                                                )}
                                            </Badge>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-xs text-muted-foreground/60 italic">
                                        {t('notes:sidebar.search.no_tags', 'No tags available')}
                                    </div>
                                )}
                            </div>
                        </PopoverContent>
                    </Popover>
                    {/* 清除按钮 */}
                    {localTerm && (
                        <NotionButton
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={handleClear}
                        >
                            <X className="h-3 w-3" />
                        </NotionButton>
                    )}
                </div>
            </div>
            {/* 已选择的标签显示 */}
            {selectedTags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {selectedTags.map(tag => (
                        <Badge
                            key={tag}
                            variant="secondary"
                            className="text-[10px] h-5 gap-1 cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors"
                            onClick={() => toggleTag(tag)}
                        >
                            <TagIcon className="h-2.5 w-2.5" />
                            {tag}
                            <X className="h-2.5 w-2.5" />
                        </Badge>
                    ))}
                </div>
            )}
        </div>
    );
};
