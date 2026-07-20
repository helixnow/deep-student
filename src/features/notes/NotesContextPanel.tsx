import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from "react-i18next";
import { TextAlignLeft, Calendar, CaretRight, Tag, Clock, X, Plus, PencilSimple, Check } from "@phosphor-icons/react";
import { useNotesOptional } from "./NotesContext";
import { CustomScrollArea } from "@/components/custom-scroll-area";
import { Separator } from "@/components/ui/shad/Separator";
import { cn } from "../../lib/utils";
import { Input } from "@/components/ui/shad/Input";
import { Badge } from "@/components/ui/shad/Badge";
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { dstu } from '@/dstu';

const normalizeHeadingText = (raw: string) => {
    const withoutLinks = raw.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    const withoutFormatting = withoutLinks.replace(/[*_`~]/g, '');
    const withoutTrailingHashes = withoutFormatting.replace(/\s*#+\s*$/, '');
    return withoutTrailingHashes.replace(/\s+/g, ' ').trim();
};

const isFenceLine = (line: string) => /^(```|~~~)/.test(line.trim());

/** 大纲 hover 预览：剥掉行首列表/引用/任务标记与行内格式 */
const normalizePreviewLine = (raw: string) => {
    const withoutBlockMarkers = raw.replace(/^\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)?/, '');
    return normalizeHeadingText(withoutBlockMarkers).slice(0, 120);
};

interface OutlineHeading {
    level: number;
    text: string;
    searchText: string;
    id: string;
    /** 标题后的首行正文（hover 预览用），可能为空 */
    preview: string;
}

import { emitOutlineDebugLog, emitOutlineDebugSnapshot } from '../../debug-panel/events/NotesOutlineDebugChannel';
import './NotesContextPanel.css';

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

const formatPanelDate = (value: string | undefined, locale: string) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
};

export const NotesContextPanel: React.FC<NotesContextPanelProps> = (props) => {
    const { t, i18n } = useTranslation(['notes', 'common']);
    
    // 检测是否为 DSTU 模式（通过是否传入 noteId 判断）
    const isDstuMode = props.noteId !== undefined;
    
    // ========== Context 获取（可选） ==========
    // 使用 useNotesOptional 而非 useNotes，在没有 Provider 时返回 null
    // 这样 DSTU 模式下无需 NotesProvider 包装
    const notesContext = useNotesOptional();
    const contextActive = notesContext?.active;
    const updateNoteTags = notesContext?.updateNoteTags;
    const renameTagAcrossNotes = notesContext?.renameTagAcrossNotes;
    
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
    const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
    const tagInputRef = useRef<HTMLInputElement>(null);
    // 标签行内重命名（双击 chip / 铅笔按钮进入；跨笔记全局传播）
    const [editingTag, setEditingTag] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [isRenamingTag, setIsRenamingTag] = useState(false);
    
    // 实时内容缓存（用于大纲实时更新）
    const [liveContent, setLiveContent] = useState<string | null>(null);
    const liveContentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const largeContentThreshold = 200_000;
    const largeContentDebounceMs = 1200;

    const lang = i18n.language || 'en-US';
    const dateLocale = lang.startsWith('zh') ? 'zh-CN' : lang;

    const tags = effectiveActive?.tags || [];
    const hasTags = tags.length > 0;
    // 标签是否可编辑：DSTU 模式看是否提供 onTagsChange（只读消费者传 undefined），
    // Context 模式看 updateNoteTags 是否可用
    const canEditTags = isDstuMode ? Boolean(props.onTagsChange) : Boolean(updateNoteTags);

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

    // 切换笔记时重置实时内容与大纲高亮
    useEffect(() => {
        setLiveContent(null);
        setActiveHeadingId(null);
        setIsAddingTag(false);
        setTagInput("");
        setEditingTag(null);
        setRenameValue("");
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

    // 大纲内容变化时，若当前高亮项已不存在则清除
    useEffect(() => {
        if (!activeHeadingId) return;
        if (!headings.some((h) => h.id === activeHeadingId)) {
            setActiveHeadingId(null);
        }
    }, [headings, activeHeadingId]);

    const handleHeadingClick = (heading: { id: string; text: string; searchText: string; level: number }) => {
        setActiveHeadingId(heading.id);
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
                // ★ Y2 修复：携带 noteId，编辑器侧按当前笔记过滤
                noteId: effectiveActive?.id,
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
            showGlobalNotification('error', t('notes:context.tag_add_failed'));
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
            showGlobalNotification('error', t('notes:context.tag_remove_failed'));
        }
    };

    /**
     * DSTU 模式下的跨笔记标签重命名回退实现。
     * 与 NotesContext.renameTagAcrossNotes 走同一 DSTU 协议
     * （dstu.list 分页 + dstu.setMetadata），仅在无 NotesProvider 时使用。
     */
    const renameTagAcrossNotesDstu = useCallback(async (
        oldName: string,
        newName: string,
        skipId: string
    ): Promise<number> => {
        const pageSize = 200;
        let offset = 0;
        let updatedCount = 0;

        while (true) {
            const result = await dstu.list('/', { typeFilter: 'note', limit: pageSize, offset });
            if (!result.ok) {
                throw new Error(result.error.toUserMessage());
            }

            for (const node of result.value) {
                if (node.id === skipId) continue;
                const nodeTags = (node.metadata?.tags as string[] | undefined) || [];
                if (!nodeTags.includes(oldName)) continue;

                const nextTags = nodeTags.map(tag => (tag === oldName ? newName : tag));
                const setResult = await dstu.setMetadata(`/${node.id}`, { tags: nextTags });
                if (!setResult.ok) {
                    throw new Error(setResult.error.toUserMessage());
                }
                updatedCount += 1;
            }

            if (result.value.length < pageSize) break;
            offset += pageSize;
        }

        return updatedCount;
    }, []);

    const handleStartRenameTag = (tag: string) => {
        setEditingTag(tag);
        setRenameValue(tag);
    };

    const handleCancelRenameTag = () => {
        setEditingTag(null);
        setRenameValue("");
    };

    const handleRenameTag = async () => {
        if (!effectiveActive) return;
        const oldName = editingTag;
        const normalizedNewName = renameValue.trim();

        if (!oldName || !normalizedNewName || oldName === normalizedNewName) {
            handleCancelRenameTag();
            return;
        }

        const currentTags = effectiveActive.tags || [];
        if (currentTags.includes(normalizedNewName)) {
            showGlobalNotification('warning', t('notes:header.tag_exists'));
            return;
        }

        setIsRenamingTag(true);
        try {
            // 1. 更新当前笔记的标签
            const newTags = currentTags.map(tag => (tag === oldName ? normalizedNewName : tag));
            if (isDstuMode) {
                if (props.onTagsChange) {
                    await props.onTagsChange(newTags);
                }
            } else if (updateNoteTags) {
                await updateNoteTags(effectiveActive.id, newTags);
            }

            // 2. 跨笔记全局传播（Context 模式复用 renameTagAcrossNotes；DSTU 模式走同协议回退）
            const updatedCount = renameTagAcrossNotes
                ? await renameTagAcrossNotes(oldName, normalizedNewName, effectiveActive.id)
                : await renameTagAcrossNotesDstu(oldName, normalizedNewName, effectiveActive.id);

            if (updatedCount > 0) {
                showGlobalNotification(
                    'success',
                    t('notes:header.rename_tag_success'),
                    t('notes:header.rename_tag_count', { count: updatedCount })
                );
            }

            handleCancelRenameTag();
        } catch (error: unknown) {
            console.error("Failed to rename tag", error);
            showGlobalNotification('error', t('notes:header.rename_failed'));
        } finally {
            setIsRenamingTag(false);
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
                <p className="text-xs">{t('notes:context.select_hint')}</p>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col bg-background text-xs text-foreground">
            {/* Metadata + Tags */}
            <div className="space-y-4 px-3 py-3">
                {/* Dates — compact, consistent formatting */}
                <div className="space-y-1.5">
                    <div className="flex min-h-7 items-center gap-2 text-muted-foreground">
                        <Calendar className="w-3.5 h-3.5 shrink-0 opacity-70" />
                        <span className="w-14 shrink-0 text-xs">{t('notes:context.created')}</span>
                        <span className="text-foreground/90 tabular-nums truncate">
                            {formatPanelDate(effectiveActive.created_at, dateLocale)}
                        </span>
                    </div>
                    <div className="flex min-h-7 items-center gap-2 text-muted-foreground">
                        <Clock className="w-3.5 h-3.5 shrink-0 opacity-70" />
                        <span className="w-14 shrink-0 text-xs">{t('notes:context.updated')}</span>
                        <span className="text-foreground/90 tabular-nums truncate">
                            {formatPanelDate(effectiveActive.updated_at, dateLocale)}
                        </span>
                    </div>
                </div>

                {/* Tags — prominent section */}
                <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <h3 className="text-xs font-medium text-muted-foreground">
                            {t('notes:context.tags')}
                        </h3>
                        {hasTags && (
                            <span className="ml-auto text-[10px] font-normal text-muted-foreground/60">
                                {tags.length}
                            </span>
                        )}
                    </div>

                    {!hasTags && !isAddingTag && (
                        <p className="pl-0.5 text-xs leading-snug text-muted-foreground/70">
                            {t('notes:context.tags_empty_hint')}
                        </p>
                    )}

                    <div className="flex flex-wrap gap-1.5 items-center">
                        {tags.map((tag: string) => (
                            <Badge
                                key={tag}
                                variant="secondary"
                                className="group h-5 gap-1 rounded-sm px-1.5 text-[11px] font-normal transition-colors duration-150 hover:bg-[var(--interactive-hover)]"
                            >
                                {canEditTags && editingTag === tag ? (
                                    <span className="flex items-center gap-1">
                                        <Input
                                            className="h-4 w-20 px-1 py-0 text-[11px]"
                                            value={renameValue}
                                            onChange={e => setRenameValue(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') handleRenameTag();
                                                if (e.key === 'Escape') handleCancelRenameTag();
                                            }}
                                            aria-label={t('notes:header.rename_tag')}
                                            autoFocus
                                        />
                                        <NotionButton
                                            variant="ghost" iconOnly size="sm"
                                            className="!h-4 !w-4 !min-w-0 opacity-70 hover:opacity-100 disabled:opacity-40"
                                            onClick={handleRenameTag}
                                            disabled={isRenamingTag}
                                            aria-label={t('notes:header.confirm_rename')}
                                        >
                                            <Check className="w-3 h-3" aria-hidden="true" />
                                        </NotionButton>
                                        <NotionButton
                                            variant="ghost" iconOnly size="sm"
                                            className="!h-4 !w-4 !min-w-0 opacity-70 hover:opacity-100 disabled:opacity-40"
                                            onClick={handleCancelRenameTag}
                                            disabled={isRenamingTag}
                                            aria-label={t('notes:header.cancel_rename')}
                                        >
                                            <X className="w-3 h-3" aria-hidden="true" />
                                        </NotionButton>
                                    </span>
                                ) : (
                                    <>
                                        <span onDoubleClick={canEditTags ? () => handleStartRenameTag(tag) : undefined}>{tag}</span>
                                        {canEditTags && (
                                            <>
                                                <NotionButton
                                                    variant="ghost" iconOnly size="sm"
                                                    className="!h-4 !w-4 !min-w-0 opacity-0 group-hover:opacity-70 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-70 hover:opacity-100 transition-opacity"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleStartRenameTag(tag);
                                                    }}
                                                    title={t('notes:header.rename_tag')}
                                                    aria-label={`${t('notes:header.rename_tag')}: ${tag}`}
                                                >
                                                    <PencilSimple className="w-3 h-3" aria-hidden="true" />
                                                </NotionButton>
                                                <NotionButton
                                                    variant="ghost" iconOnly size="sm"
                                                    className="!h-4 !w-4 !min-w-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-70 hover:text-destructive transition-opacity"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleRemoveTag(tag);
                                                    }}
                                                    aria-label={`${t('notes:context.tag_remove')} ${tag}`}
                                                >
                                                    <X className="w-3 h-3" aria-hidden="true" />
                                                </NotionButton>
                                            </>
                                        )}
                                    </>
                                )}
                            </Badge>
                        ))}

                        {!canEditTags ? null : isAddingTag ? (
                            <Input
                                ref={tagInputRef}
                                className="h-6 w-28 text-[11px] px-2 py-0"
                                value={tagInput}
                                placeholder={t('notes:context.add_tag')}
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
                            <NotionButton
                                variant="ghost" size="sm"
                                className={cn(
                                    "inline-flex items-center gap-0.5 rounded-sm text-[11px] text-muted-foreground hover:text-foreground",
                                    "px-1.5 h-6 transition-colors",
                                    "[@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:px-2.5"
                                )}
                                onClick={() => setIsAddingTag(true)}
                            >
                                <Plus className="w-3 h-3" />
                                {t('notes:context.add_tag')}
                            </NotionButton>
                        )}
                    </div>
                </div>
            </div>

            <Separator />

            {/* Outline Section */}
            <div className="flex-1 flex flex-col min-h-0">
                <div className="px-3 pt-3 pb-1">
                    <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <TextAlignLeft className="w-3.5 h-3.5" />
                        {t('notes:context.outline')}
                        {headings.length > 0 && (
                            <span className="ml-auto text-[10px] font-normal text-muted-foreground/60">
                                {headings.length}
                            </span>
                        )}
                    </h3>
                </div>
                <CustomScrollArea className="flex-1">
                    <div className="px-3 pb-3 pt-0 space-y-0.5">
                        {headings.length > 0 ? (
                            headings.map((heading) => {
                                const isActive = activeHeadingId === heading.id;
                                return (
                                    <NotionButton
                                        key={heading.id}
                                        variant="ghost" size="sm"
                                        className={cn(
                                            "!h-7 !w-full !justify-start !rounded-sm !px-2 !py-1 !text-left text-xs",
                                            "[@media(pointer:coarse)]:!py-2.5",
                                            heading.level === 1 && "font-medium",
                                            isActive
                                                ? "bg-[var(--interactive-hover)] text-foreground font-medium shadow-[inset_2px_0_0_hsl(var(--primary))]"
                                                : cn(
                                                    "hover:bg-[var(--interactive-hover)] hover:text-foreground",
                                                    heading.level === 1 && "text-foreground",
                                                    heading.level === 2 && "text-muted-foreground",
                                                    heading.level === 3 && "text-muted-foreground/80",
                                                    heading.level === 4 && "text-muted-foreground/70",
                                                    heading.level === 5 && "text-muted-foreground/60",
                                                    heading.level === 6 && "text-muted-foreground/50",
                                                ),
                                        )}
                                        onClick={() => handleHeadingClick(heading)}
                                        title={heading.text}
                                        aria-current={isActive ? 'true' : undefined}
                                    >
                                        {/* 层级缩进线：每深一级增加一条竖向导轨 */}
                                        {heading.level > 1 && Array.from({ length: heading.level - 1 }).map((_, guideIndex) => (
                                            <span
                                                key={guideIndex}
                                                className="w-2 shrink-0 self-stretch border-l border-border/50 ml-[3px]"
                                                aria-hidden="true"
                                            />
                                        ))}
                                        <span className="min-w-0 flex-1 truncate">{heading.text}</span>
                                    </NotionButton>
                                );
                            })
                        ) : (
                            <div className="py-5 px-1 text-center space-y-1">
                                <p className="text-[11px] text-muted-foreground/55">
                                    {t('notes:context.no_headings')}
                                </p>
                                <p className="text-[10px] text-muted-foreground/40 leading-snug">
                                    {t('notes:context.outline_empty_hint')}
                                </p>
                            </div>
                        )}
                    </div>
                </CustomScrollArea>
            </div>
        </div>
    );
};
