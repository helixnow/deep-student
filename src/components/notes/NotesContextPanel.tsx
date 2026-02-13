import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AlignLeft, Calendar, Tag, Clock, X } from "lucide-react";
import { useNotesOptional } from "./NotesContext";
import { CustomScrollArea } from "@/components/custom-scroll-area";
import { Separator } from "../ui/shad/Separator";
import { cn } from "../../lib/utils";
import { Input } from "../ui/shad/Input";
import { Badge } from "../ui/shad/Badge";
import { showGlobalNotification } from '@/components/UnifiedNotification';

const normalizeHeadingText = (raw: string) => {
    const withoutLinks = raw.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    const withoutFormatting = withoutLinks.replace(/[*_`~]/g, '');
    const withoutTrailingHashes = withoutFormatting.replace(/\s*#+\s*$/, '');
    return withoutTrailingHashes.replace(/\s+/g, ' ').trim();
};

const isFenceLine = (line: string) => /^(```|~~~)/.test(line.trim());



import { emitOutlineDebugLog, emitOutlineDebugSnapshot } from '../../debug-panel/events/NotesOutlineDebugChannel';

// ============================================================================
// DSTU 模式 Props 接口
// ============================================================================

export interface NotesContextPanelProps {
    // ========== DSTU 模式 props ==========
    /** 笔记 ID（DSTU 模式） */
    noteId?: string;
    /** 笔记标题（DSTU 模式） */
    title?: string;
    /** 创建时间（DSTU 模式，Unix 毫秒） */
    createdAt?: number;
    /** 更新时间（DSTU 模式，Unix 毫秒） */
    updatedAt?: number;
    /** 标签（DSTU 模式） */
    tags?: string[];
    /** 内容（DSTU 模式，用于大纲解析） */
    content?: string;
    /** 标签变更回调（DSTU 模式） */
    onTagsChange?: (tags: string[]) => Promise<void>;
}

export const NotesContextPanel: React.FC<NotesContextPanelProps> = (props) => {
    const { t } = useTranslation(['notes', 'common']);
    
    // 检测是否为 DSTU 模式（通过是否传入 noteId 判断）
    const isDstuMode = props.noteId !== undefined;
    
    // ========== Context 获取（可选） ==========
    // 使用 useNotesOptional 而非 useNotes，在没有 Provider 时返回 null
    // 这样 DSTU 模式下无需 NotesProvider 包装
    const notesContext = useNotesOptional();
    const contextActive = notesContext?.active;
    const updateNoteTags = notesContext?.updateNoteTags;
    
    // ========== 数据来源判断 ==========
    // DSTU 模式：使用传入的 props
    // Context 模式：使用 NotesContext 的 active
    const effectiveActive = isDstuMode
        ? {
            id: props.noteId!,
            title: props.title || '',
            created_at: props.createdAt ? new Date(props.createdAt).toISOString() : undefined,
            updated_at: props.updatedAt ? new Date(props.updatedAt).toISOString() : undefined,
            tags: props.tags || [],
            content_md: props.content || '',
        }
        : contextActive;
    
    const [headings, setHeadings] = useState<Array<{ level: number; text: string; searchText: string; id: string }>>([]);
    const [tagInput, setTagInput] = useState("");
    const [isAddingTag, setIsAddingTag] = useState(false);
    const tagInputRef = useRef<HTMLInputElement>(null);
    
    // 实时内容缓存（用于大纲实时更新）
    const [liveContent, setLiveContent] = useState<string | null>(null);
    const liveContentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const largeContentThreshold = 200_000;
    const largeContentDebounceMs = 1200;




    // 解析标题的工具函数
    const parseHeadings = useCallback((content: string) => {
        const start = performance.now();
        const lines = content.split('\n');
        const extractedHeadings: Array<{ level: number; text: string; searchText: string; id: string }> = [];
        let inFence = false;
        let headingCount = 0;

        lines.forEach((line, index) => {
            if (isFenceLine(line)) {
                inFence = !inFence;
                return;
            }
            if (inFence) return;
            // 支持 1-6 级标题
            const match = line.match(/^(#{1,6})\s+(.+)$/);
            if (match) {
                const rawText = match[2].trim();
                const normalized = normalizeHeadingText(rawText);
                const displayText = normalized || rawText;
                headingCount++;
                extractedHeadings.push({
                    level: match[1].length,
                    text: displayText,
                    searchText: (normalized || rawText).toLowerCase(),
                    id: `heading-${headingCount}-${index}`,
                });
            }
        });
        const duration = performance.now() - start;
        emitOutlineDebugLog({
            category: 'outline',
            action: 'parseHeadings:complete',
            details: {
                noteId: effectiveActive?.id || null,
                headings: extractedHeadings.length,
                durationMs: Number(duration.toFixed(2)),
            },
        });
        return extractedHeadings;
    }, [effectiveActive?.id]);

    // 监听编辑器实时内容变化（300ms 防抖）
    useEffect(() => {
        const handleContentChanged = (e: CustomEvent<{ noteId: string; content: string }>) => {
            if (e.detail.noteId !== effectiveActive?.id) return;
            
            // 防抖更新
            if (liveContentDebounceRef.current) {
                clearTimeout(liveContentDebounceRef.current);
            }
            const contentLength = e.detail.content.length;
            const debounceMs = contentLength > largeContentThreshold ? largeContentDebounceMs : 300;
            liveContentDebounceRef.current = setTimeout(() => {
                setLiveContent(e.detail.content);
            }, debounceMs);
        };

        window.addEventListener('notes:content-changed', handleContentChanged as EventListener);
        return () => {
            window.removeEventListener('notes:content-changed', handleContentChanged as EventListener);
            if (liveContentDebounceRef.current) {
                clearTimeout(liveContentDebounceRef.current);
            }
        };
    }, [effectiveActive?.id]);

    // 切换笔记时重置实时内容
    useEffect(() => {
        setLiveContent(null);
    }, [effectiveActive?.id]);

    // Parse headings from active note content (支持 1-6 级标题)
    // 优先使用实时内容，否则使用保存的内容
    useEffect(() => {
        const content = liveContent ?? effectiveActive?.content_md;
        if (!content) {
            setHeadings([]);
            return;
        }

        if (content.length > largeContentThreshold) {
            let idleHandle: number | ReturnType<typeof setTimeout> | null = null;
            const run = () => setHeadings(parseHeadings(content));
            const requestIdle = typeof window !== 'undefined' ? (window as any).requestIdleCallback : undefined;
            const cancelIdle = typeof window !== 'undefined' ? (window as any).cancelIdleCallback : undefined;

            if (typeof requestIdle === 'function') {
                idleHandle = requestIdle(run, { timeout: 2000 });
            } else {
                idleHandle = setTimeout(run, largeContentDebounceMs);
            }

            return () => {
                if (idleHandle != null) {
                    if (typeof cancelIdle === 'function') {
                        cancelIdle(idleHandle as number);
                    } else {
                        clearTimeout(idleHandle as ReturnType<typeof setTimeout>);
                    }
                }
            };
        }

        setHeadings(parseHeadings(content));
    }, [liveContent, effectiveActive?.content_md, parseHeadings, largeContentThreshold, largeContentDebounceMs]);

    const handleHeadingClick = (heading: { text: string; searchText: string; level: number }) => {
        emitOutlineDebugLog({
            category: 'event',
            action: 'outline:headingClick',
            details: {
                heading,
                noteId: effectiveActive?.id || null,
            },
        });
        emitOutlineDebugSnapshot({
            noteId: effectiveActive?.id || null,
            heading: {
                text: heading.text,
                normalized: heading.searchText,
                level: heading.level,
            },
            outlineState: {
                headings: headings.length,
                liveContent: !!liveContent,
            },
            scrollEvent: {
                reason: 'outline-click',
                exactMatch: false,
            },
        });
        window.dispatchEvent(new CustomEvent('notes:scroll-to-heading', {
            detail: {
                text: heading.text,
                normalizedText: heading.searchText,
                level: heading.level,
            },
        }));
    };

    const handleAddTag = async () => {
        if (!tagInput.trim() || !effectiveActive) return;
        if (!isDstuMode && !updateNoteTags) return;

        const newTag = tagInput.trim();
        if (effectiveActive.tags?.includes(newTag)) {
            setTagInput("");
            setIsAddingTag(false);
            return;
        }

        const newTags = [...(effectiveActive.tags || []), newTag];

        try {
            if (isDstuMode) {
                // DSTU 模式：调用 onTagsChange 回调
                if (props.onTagsChange) {
                    await props.onTagsChange(newTags);
                }
            } else {
                // Context 模式：使用 updateNoteTags
                if (updateNoteTags) {
                    await updateNoteTags(effectiveActive.id, newTags);
                }
            }

            setTagInput("");
            setIsAddingTag(false);
        } catch (error: unknown) {
            console.error("Failed to add tag", error);
            showGlobalNotification('error', t('notes:context.tag_add_failed', 'Failed to add tag'));
        }
    };

    const handleRemoveTag = async (tagToRemove: string) => {
        if (!effectiveActive) return;
        if (!isDstuMode && !updateNoteTags) return;

        const newTags = (effectiveActive.tags || []).filter(t => t !== tagToRemove);

        try {
            if (isDstuMode) {
                // DSTU 模式：调用 onTagsChange 回调
                if (props.onTagsChange) {
                    await props.onTagsChange(newTags);
                }
            } else {
                // Context 模式：使用 updateNoteTags
                if (updateNoteTags) {
                    await updateNoteTags(effectiveActive.id, newTags);
                }
            }
        } catch (error: unknown) {
            console.error("Failed to remove tag", error);
            showGlobalNotification('error', t('notes:context.tag_remove_failed', 'Failed to remove tag'));
        }
    };

    useEffect(() => {
        if (isAddingTag && tagInputRef.current) {
            tagInputRef.current.focus();
        }
    }, [isAddingTag]);

    if (!effectiveActive) {
        return (
            <div className="flex flex-col h-full items-center justify-center text-muted-foreground/50 bg-muted/5">
                <p className="text-xs">{t('notes:context.select_hint', 'Select a note to view context')}</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-muted/5 border-l border-border/40 text-xs">
            {/* Properties Section */}
            <div className="p-4 space-y-3">
                <div className="space-y-3">
                    {/* Dates */}
                    <div className="flex items-center gap-2 text-muted-foreground">
                        <Calendar className="w-3.5 h-3.5 shrink-0" />
                        <span className="w-16 shrink-0">{t('notes:context.created', 'Created')}</span>
                        <span className="text-foreground truncate">{effectiveActive.created_at ? new Date(effectiveActive.created_at).toLocaleDateString() : '-'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                        <Clock className="w-3.5 h-3.5 shrink-0" />
                        <span className="w-16 shrink-0">{t('notes:context.updated', 'Updated')}</span>
                        <span className="text-foreground truncate">{effectiveActive.updated_at ? new Date(effectiveActive.updated_at).toLocaleDateString() : '-'}</span>
                    </div>

                    {/* Tags */}
                    <div className="flex flex-col gap-2 pt-1">
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <Tag className="w-3.5 h-3.5 shrink-0" />
                            <span className="w-16 shrink-0">{t('notes:context.tags', 'Tags')}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 pl-5">
                            {(effectiveActive.tags || []).map((tag: string) => (
                                <Badge
                                    key={tag}
                                    variant="secondary"
                                    className="h-5 px-1.5 text-[10px] font-normal gap-1 hover:bg-muted-foreground/20 transition-colors cursor-default group"
                                >
                                    {tag}
                                    <X
                                        className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 cursor-pointer hover:text-destructive transition-opacity"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleRemoveTag(tag);
                                        }}
                                    />
                                </Badge>
                            ))}

                            {isAddingTag ? (
                                <Input
                                    ref={tagInputRef}
                                    className="h-5 w-20 text-[10px] px-1 py-0"
                                    value={tagInput}
                                    onChange={e => setTagInput(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') handleAddTag();
                                        if (e.key === 'Escape') {
                                            setIsAddingTag(false);
                                            setTagInput("");
                                        }
                                    }}
                                    onBlur={() => {
                                        if (tagInput) handleAddTag();
                                        else setIsAddingTag(false);
                                    }}
                                />
                            ) : (
                                <span
                                    className="text-[10px] text-muted-foreground/60 italic hover:text-primary cursor-pointer transition-colors px-1"
                                    onClick={() => setIsAddingTag(true)}
                                >
                                    + {t('notes:context.add_tag', 'Add tag')}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <Separator />

            {/* Outline Section */}
            <div className="flex-1 flex flex-col min-h-0">
                <div className="p-3 pb-1">
                    <h3 className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider flex items-center gap-1.5">
                        <AlignLeft className="w-3 h-3" />
                        {t('notes:context.outline', 'OUTLINE')}
                        {headings.length > 0 && (
                            <span className="text-[9px] font-normal text-muted-foreground/50 ml-auto">
                                {headings.length}
                            </span>
                        )}
                    </h3>
                </div>
                <CustomScrollArea className="flex-1">
                    <div className="p-3 pt-0 space-y-0.5">
                        {headings.length > 0 ? (
                            headings.map((heading) => (
                                <button
                                    key={heading.id}
                                    className={cn(
                                        "w-full text-left py-1 px-2 rounded-md hover:bg-muted/60 transition-colors truncate text-[11px]",
                                        // 1-6 级标题样式
                                        heading.level === 1 && "font-medium text-foreground",
                                        heading.level === 2 && "pl-4 text-muted-foreground",
                                        heading.level === 3 && "pl-6 text-muted-foreground/80",
                                        heading.level === 4 && "pl-8 text-muted-foreground/70 text-[10px]",
                                        heading.level === 5 && "pl-10 text-muted-foreground/60 text-[10px]",
                                        heading.level === 6 && "pl-12 text-muted-foreground/50 text-[10px]"
                                    )}
                                    onClick={() => handleHeadingClick(heading)}
                                    title={heading.text}
                                >
                                    {heading.text}
                                </button>
                            ))
                        ) : (
                            <div className="py-4 text-center text-muted-foreground/40 italic">
                                {t('notes:context.no_headings', 'No headings')}
                            </div>
                        )}
                    </div>
                </CustomScrollArea>
            </div>
        </div>
    );
};
