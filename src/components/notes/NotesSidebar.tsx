import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
    Search,
    Plus,
    RefreshCw,
    Trash2,
    Settings,
    MoreHorizontal,
    ChevronLeft,
    ChevronRight,
    Folder,
    FolderPlus,
    Star,
    BookOpen,
    Link,
} from "lucide-react";
import { NotionButton } from '@/components/ui/NotionButton';
import { Z_INDEX } from '@/config/zIndex';
import { Input } from "../ui/shad/Input";
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody, NotionDialogFooter } from '../ui/NotionDialog';
import {
    AppMenu,
    AppMenuContent,
    AppMenuItem,
    AppMenuTrigger,
    AppMenuSeparator,
    AppMenuGroup,
} from "../ui/app-menu";
import { DndFileTree, type TreeData, type DragInfo } from "./DndFileTree";
import { useNotes } from "./NotesContext";
import { buildTreeData, getPathToNote } from "./notesUtils";
import { useDebounce } from "../../hooks/useDebounce";
import { cn } from "../../lib/utils";
import { NotesSidebarSearch } from "./components/NotesSidebarSearch";
import { AddReferenceDropdown } from "./components/AddReferenceDropdown";
import { invoke } from '@tauri-apps/api/core';
import { isReferenceId, isFolderId } from "./types/reference";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CustomScrollArea } from "../custom-scroll-area";
import { showGlobalNotification } from "../UnifiedNotification";
// ★ DSTU API 导入 (Prompt 8)
import { openResource, buildContextMenu, registerContextMenuActionHandler } from "@/dstu";
import type { DstuNode } from "@/dstu/types";
import type { ContextMenuItem } from "@/dstu/editorTypes";

const stripHtml = (raw: string) => raw.replace(/<[^>]*>/g, '');

interface NotesSidebarProps {
    isCollapsed: boolean;
    onToggleCollapse: () => void;
}

export const NotesSidebar: React.FC<NotesSidebarProps> = ({ isCollapsed, onToggleCollapse }) => {
    const { t } = useTranslation(['notes', 'common']);
    const {
        notes,
        folders,
        rootChildren,
        loading,
        active,
        setActive,
        refreshNotes,
        setTrashOpen,
        createNote,
        createFolder,
        moveItem,
        renameItem,
        deleteItems,
        toggleFavorite,
        performSearch,
        searchResults,
        isSearching,
        searchQuery,
        ensureNoteContent,
        // ★ 引用管理方法（Prompt 6）
        references,
        addTextbookRef,
        removeRef,
        // ★ 引用有效性校验方法（Prompt 10）
        validateReference,
        batchValidateReferences,
    } = useNotes();

    // Removed local searchTerm state as it was unused and confusing
    const [sortMethod, setSortMethod] = useState("name_asc");
    const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [expandedIds, setExpandedIds] = useState<string[]>([]);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
    const [referenceDialog, setReferenceDialog] = useState<{
        open: boolean;
        type: 'textbook';
        folderId: string | null;
    }>({ open: false, type: 'textbook', folderId: null });
    const [referenceValue, setReferenceValue] = useState('');
    const [referenceSubmitting, setReferenceSubmitting] = useState(false);
    const searchListRef = useRef<HTMLDivElement>(null);

    // ESC 键关闭右键菜单
    useEffect(() => {
        if (!contextMenu) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setContextMenu(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [contextMenu]);

    const openReferenceDialog = useCallback((type: 'textbook', folderId: string) => {
        setReferenceValue('');
        setReferenceDialog({ open: true, type, folderId });
    }, []);

    const closeReferenceDialog = useCallback(() => {
        setReferenceDialog(prev => ({ ...prev, open: false }));
        setReferenceValue('');
        setReferenceSubmitting(false);
    }, []);

    const submitReference = useCallback(async () => {
        if (!referenceDialog.folderId || referenceSubmitting) return;
        const value = referenceValue.trim();
        if (!value) {
            showGlobalNotification('warning', t('notes:reference.empty_id'));
            return;
        }

        setReferenceSubmitting(true);
        try {
            await addTextbookRef(value, referenceDialog.folderId);
            closeReferenceDialog();
        } catch (error: unknown) {
            console.error('[NotesSidebar] Failed to add reference', error);
            showGlobalNotification('error', t('notes:reference.add_failed'));
            setReferenceSubmitting(false);
        }
    }, [referenceDialog, referenceSubmitting, referenceValue, addTextbookRef, closeReferenceDialog, t]);

    // Handle external reveal request
    const { sidebarRevealId, setSidebarRevealId } = useNotes();

    // ✅ 修复：将 useVirtualizer 移到条件判断之前，确保 hooks 调用顺序稳定
    // Virtualizer for search results - 必须放在所有条件返回之前
    const rowVirtualizer = useVirtualizer({
        count: searchResults.length,
        getScrollElement: () => searchListRef.current,
        estimateSize: () => 60, // Estimated height for search result item
        overscan: 5,
    });

    React.useEffect(() => {
        if (sidebarRevealId) {
            setSelectedNodeId(sidebarRevealId);

            // Calculate path to expand
            const path = getPathToNote(sidebarRevealId, folders, notes);
            const parentIds = path.slice(0, -1).map(p => p.id);

            if (parentIds.length > 0) {
                setExpandedIds(prev => {
                    const next = new Set([...prev, ...parentIds]);
                    return Array.from(next);
                });
            }

            setSidebarRevealId(null);
        }
    }, [sidebarRevealId, folders, notes, setSidebarRevealId]);

    // 筛选后的笔记列表（收藏模式）
    const filteredNotes = useMemo(() => {
        if (!showFavoritesOnly) return notes;
        return notes.filter(n => n.is_favorite);
    }, [notes, showFavoritesOnly]);

    const treeData: TreeData = useMemo(() => {
        return buildTreeData({
            notes: filteredNotes,
            folders: showFavoritesOnly ? {} : folders, // 收藏模式下不显示文件夹
            rootChildren: showFavoritesOnly ? filteredNotes.map(n => n.id) : rootChildren,
            noteRootLabel: showFavoritesOnly 
                ? t('notes:sidebar.favorites.title') 
                : t('notes:common.noteRoot'),
            untitledLabel: t('notes:common.untitled'),
            sortMethod
        });
    }, [filteredNotes, folders, rootChildren, sortMethod, showFavoritesOnly, t]);

    // Sync selection with active note
    React.useEffect(() => {
        if (active) {
            setSelectedNodeId(active.id);
        }
    }, [active]);

    const handleCreateNote = async () => {
        let parentId: string | undefined;

        if (selectedNodeId) {
            const node = treeData[selectedNodeId];
            if (node) {
                if (node.isFolder) {
                    // Create inside folder
                    parentId = selectedNodeId;
                } else {
                    // Create next to file (same parent)
                    const pid = node.data?.parentId;
                    if (pid && pid !== 'root') {
                        parentId = pid;
                    }
                }
            }
        }

        const id = await createNote(parentId);
        if (id) setRenamingId(id);
    };

    const handleCreateFolder = async () => {
        let parentId: string | undefined;

        if (selectedNodeId) {
            const node = treeData[selectedNodeId];
            if (node) {
                if (node.isFolder) {
                     parentId = selectedNodeId;
                } else {
                    const pid = node.data?.parentId;
                    if (pid && pid !== 'root') {
                        parentId = pid;
                    }
                }
            }
        }

        const id = await createFolder(parentId);
        if (id) setRenamingId(id);
    };

    const handleContextMenu = useCallback((id: string, e: React.MouseEvent) => {
        e.preventDefault();
        // Also select the node on right click if not already selected
        setSelectedNodeId(id);
        
        // 边界检测：确保菜单不会超出视口
        const menuWidth = 160; // 估算菜单宽度
        const menuHeight = 120; // 估算菜单高度
        const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
        const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
        
        setContextMenu({ x, y, id });
    }, []);

    // ★ Prompt 8: 使用 buildContextMenu 构建 DSTU 菜单项
    const buildDstuMenuItems = useCallback((id: string): ContextMenuItem[] => {
        const note = notes.find(n => n.id === id);
        if (!note) return [];

        const dstuPath = `/${id}`;
        const dstuNode: DstuNode = {
            id: note.id,
            sourceId: note.id,
            path: dstuPath,
            name: note.title,
            type: 'note',
            size: note.content_md?.length || 0,
            createdAt: new Date(note.created_at).getTime(),
            updatedAt: new Date(note.updated_at).getTime(),
            previewType: 'markdown',
        };

        return buildContextMenu(dstuNode, { showOpen: false });
    }, [notes]);

    const selectedIds = useMemo(() => {
        if (selectedNodeId) return [selectedNodeId];
        return active ? [active.id] : [];
    }, [active, selectedNodeId]);


    const handleDrop = useCallback((info: DragInfo) => {
        const { draggedIds, targetId, position } = info;

        const targetNode = treeData[targetId];
        if (!targetNode) return;

        let parentId: string | null = null;
        let index = 0;

        if (position === 'inside') {
            parentId = targetId;
            // Append to end
            index = treeData[targetId].children?.length || 0;
        } else {
            parentId = targetNode.data?.parentId || null;
            if (parentId === 'root') parentId = null; // Context uses null for root

            // Find index in parent's children
            const parentChildren = parentId
                ? treeData[parentId]?.children
                : treeData['root']?.children;

            if (parentChildren) {
                const targetIndex = parentChildren.indexOf(targetId);
                index = position === 'after' ? targetIndex + 1 : targetIndex;
            }
        }

        moveItem(draggedIds, parentId, index);
    }, [treeData, moveItem]);

    const showSearchResults = Boolean(searchQuery && (isSearching || searchResults.length > 0));

    const renderHighlight = useCallback((raw: string) => {
        const q = (searchQuery || '').trim();
        if (!q) return raw;
        const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(esc, 'gi');
        const parts = raw.split(re);
        const matches = raw.match(re);
        if (!matches) return raw;
        const out: React.ReactNode[] = [];
        parts.forEach((p, i) => {
            out.push(p);
            const m = matches[i];
            if (m) out.push(<mark key={i} className="bg-primary/20 text-foreground/90 rounded px-0.5">{m}</mark>);
        });
        return <>{out}</>;
    }, [searchQuery]);

    // ✅ 修复：将 useEffect 移到条件判断之前，确保 hooks 调用顺序稳定
    useEffect(() => {
        const loadSortPref = async () => {
            const v = await invoke<string | null>('notes_get_pref', { key: 'notes_sort:default' });
            if (typeof v === 'string' && v) setSortMethod(v);
        };
        void loadSortPref();
    }, []);

    // Collapsed View - 现在可以安全地在这里返回，因为所有 hooks 已经在上面调用
    if (isCollapsed) {
        return (
            <div className="h-full flex flex-col items-center py-4 border-r border-border/40 bg-muted/5 w-full">
                <NotionButton
                    variant="ghost"
                    iconOnly size="sm"
                    className="h-8 w-8 mb-4 hover:bg-muted"
                    onClick={onToggleCollapse}
                    title={t('notes:sidebar.expand')}
                >
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </NotionButton>

                <div className="flex flex-col gap-2 w-full items-center">
                    <NotionButton variant="ghost" iconOnly size="sm" className="h-8 w-8 hover:bg-muted" onClick={handleCreateNote} title={t('notes:sidebar.actions.new_note')}>
                         <Plus className="h-4 w-4 text-muted-foreground" />
                    </NotionButton>
                    <NotionButton variant="ghost" iconOnly size="sm" className="h-8 w-8 hover:bg-muted"                     onClick={handleCreateFolder} title={t('notes:sidebar.actions.new_folder')}>
                         <FolderPlus className="h-4 w-4 text-muted-foreground" />
                    </NotionButton>
                     <NotionButton variant="ghost" iconOnly size="sm" className="h-8 w-8 hover:bg-muted" onClick={() => refreshNotes()} title={t('notes:sidebar.actions.refresh')}>
                         <RefreshCw className="h-4 w-4 text-muted-foreground" />
                    </NotionButton>
                </div>
            </div>
        );
    }

    const changeSort = async (next: string) => {
        setSortMethod(next);
        await invoke<boolean>('notes_set_pref', { key: 'notes_sort:default', value: next });
    };

    const referenceDialogTitle = t('notes:reference.add_textbook');
    const referenceDialogPlaceholder = t('notes:reference.enter_textbook_id');

    return (
        <div className="flex flex-col h-full relative group/sidebar">
            {/* Header: Breadcrumb & Search */}
            <div className="p-3 pb-0 space-y-3">
                <div className="flex items-center gap-1 min-h-[36px]">
                    <NotionButton 
                        variant="ghost" 
                        iconOnly size="sm"
                        className="h-8 w-8 text-muted-foreground/70 hover:text-foreground"
                        onClick={handleCreateNote}
                        title={t('notes:sidebar.actions.new_note')}
                    >
                        <Plus className="h-4 w-4" />
                    </NotionButton>
                    <NotionButton 
                        variant="ghost" 
                        iconOnly size="sm"
                        className="h-8 w-8 text-muted-foreground/70 hover:text-foreground"
                        onClick={handleCreateFolder}
                        title={t('notes:sidebar.actions.new_folder')}
                    >
                        <FolderPlus className="h-4 w-4" />
                    </NotionButton>
                    <NotionButton 
                        variant="ghost" 
                        iconOnly size="sm"
                        className="h-8 w-8 text-muted-foreground/70 hover:text-foreground"
                        onClick={() => refreshNotes()}
                        title={t('notes:sidebar.actions.refresh')}
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                    </NotionButton>
                    <NotionButton 
                        variant="ghost" 
                        iconOnly size="sm"
                        className={cn(
                            "h-8 w-8 hover:text-foreground",
                            showFavoritesOnly 
                                ? "text-warning hover:text-warning/80" 
                                : "text-muted-foreground/70"
                        )}
                        onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                        title={showFavoritesOnly 
                            ? t('notes:sidebar.actions.favorites_filter_off') 
                            : t('notes:sidebar.actions.favorites_filter_on')
                        }
                    >
                        <Star className={cn("h-3.5 w-3.5", showFavoritesOnly && "fill-current")} />
                    </NotionButton>

                    {/* ★ 添加引用下拉菜单（Prompt 6） */}
                    <AddReferenceDropdown
                        selectedFolderId={
                            selectedNodeId && treeData[selectedNodeId]?.isFolder
                                ? selectedNodeId
                                : undefined
                        }
                        compact
                    />

                    <AppMenu>
                        <AppMenuTrigger asChild>
                            <NotionButton 
                                variant="ghost" 
                                size="sm"
                                className="h-8 px-2 text-[11px] text-muted-foreground/70 hover:text-foreground"
                                title={t('notes:sidebar.actions.sort')}
                            >
                                {t('notes:sidebar.actions.sort_name_asc')}
                            </NotionButton>
                        </AppMenuTrigger>
                        <AppMenuContent align="start" width={160}>
                            <AppMenuItem onClick={() => changeSort('name_asc')}>{t('notes:sidebar.actions.sort_name_asc')}</AppMenuItem>
                            <AppMenuItem onClick={() => changeSort('name_desc')}>{t('notes:sidebar.actions.sort_name_desc')}</AppMenuItem>
                            <AppMenuSeparator />
                            <AppMenuItem onClick={() => changeSort('modified_desc')}>{t('notes:sidebar.actions.sort_modified_desc')}</AppMenuItem>
                            <AppMenuItem onClick={() => changeSort('modified_asc')}>{t('notes:sidebar.actions.sort_modified_asc')}</AppMenuItem>
                            <AppMenuSeparator />
                            <AppMenuItem onClick={() => changeSort('created_desc')}>{t('notes:sidebar.actions.sort_created_desc')}</AppMenuItem>
                            <AppMenuItem onClick={() => changeSort('created_asc')}>{t('notes:sidebar.actions.sort_created_asc')}</AppMenuItem>
                        </AppMenuContent>
                    </AppMenu>

                     {/* Collapse Button - Pushed to right */}
                    <NotionButton 
                        variant="ghost" 
                        iconOnly size="sm"
                        className="h-8 w-8 text-muted-foreground/50 hover:text-foreground ml-auto"
                        onClick={onToggleCollapse}
                        title={t('notes:sidebar.collapse')}
                    >
                        <ChevronLeft className="h-3.5 w-3.5" />
                    </NotionButton>
                </div>
                
                {/* Quick Action / Search - visually minimal */}
                 <NotesSidebarSearch />
            </div>
            
            {/* Section Divider */}
            <div className="px-3 py-2">
                 <div className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider pl-2 flex items-center justify-between">
                    <span>{t('notes:tree.root')}</span>
                 </div>
            </div>

            {/* Tree Area */}
            <div className="flex-1 min-h-0 relative" onContextMenu={(e) => e.preventDefault()}>
                {(loading || (isSearching && searchResults.length === 0 && searchQuery)) ? (
                     isSearching ? (
                         <div className="absolute inset-0 flex items-center justify-center">
                             <span className="loading loading-spinner loading-sm text-muted-foreground/30" />
                         </div>
                     ) : loading ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <span className="loading loading-spinner loading-sm text-muted-foreground/30" />
                        </div>
                     ) : showSearchResults ? (
                         <div className="p-4 text-center text-sm text-muted-foreground">
                            {t('notes:search.no_results')}
                         </div>
                     ) : null
                ) : showSearchResults ? (
                    <CustomScrollArea className="absolute inset-0" viewportRef={searchListRef} viewportClassName="p-2">
                        <div
                            style={{
                                height: `${rowVirtualizer.getTotalSize()}px`,
                                width: '100%',
                                position: 'relative',
                            }}
                        >
                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                const res = searchResults[virtualRow.index];
                                
                                const path = getPathToNote(res.id, folders, notes);
                                const folderPath = path.slice(0, -1).map(p => p.title).join(' / ');

                                return (
                                    <div
                                        key={res.id}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            width: '100%',
                                            height: `${virtualRow.size}px`,
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                        className="p-1"
                                    >
                                            <div 
                                                className="p-2 rounded-md hover:bg-muted/50 cursor-pointer text-sm group transition-colors h-full"
                                                onClick={() => {
                                                    const note = notes.find(n => n.id === res.id);
                                                    if (note) setActive(note);
                                                    void ensureNoteContent(res.id);
                                                }}
                                            >
                                                <div className="font-medium truncate text-foreground/80 group-hover:text-foreground">{renderHighlight(res.title)}</div>
                                                {folderPath && (
                                                    <div className="text-[10px] text-muted-foreground/50 truncate flex items-center gap-1 mt-0.5">
                                                        <Folder className="w-3 h-3 shrink-0" />
                                                        {folderPath}
                                                    </div>
                                                )}
                                                {res.snippet && (
                                                    <div className="text-xs text-muted-foreground/60 line-clamp-2 mt-1 pl-1 border-l-2 border-primary/20">
                                                        {renderHighlight(stripHtml(res.snippet))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                        </div>
                    </CustomScrollArea>
                ) : showFavoritesOnly && filteredNotes.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full p-4 text-center">
                        <Star className="h-8 w-8 text-muted-foreground/30 mb-3" />
                        <p className="text-sm text-muted-foreground">
                            {t('notes:sidebar.favorites.empty')}
                        </p>
                        <p className="text-xs text-muted-foreground/60 mt-1">
                            {t('notes:sidebar.favorites.empty_hint')}
                        </p>
                    </div>
                ) : (
                    <CustomScrollArea className="h-full" viewportClassName="pl-1 pr-1">
                        <DndFileTree
                            treeData={treeData}
                            selectedIds={selectedIds}
                            onSelect={(ids) => {
                                const id = ids[0];
                                setSelectedNodeId(id);
                                const note = notes.find(n => n.id === id);
                                if (note) setActive(note);
                                if (note) void ensureNoteContent(note.id);
                                // ★ Prompt 10: 选中引用节点时异步校验
                                if (isReferenceId(id)) {
                                    void validateReference(id);
                                }
                            }}
                            // ★ Prompt 8: 双击打开使用 openResource()
                            onDoubleClick={async (id) => {
                                // 非引用节点的双击打开
                                if (isReferenceId(id)) return;

                                const note = notes.find(n => n.id === id);
                                if (!note) return;

                                // 使用 DSTU openResource
                                try {
                                    const dstuPath = `/${id}`;
                                    const dstuNode: DstuNode = {
                                        id: note.id,
                                        sourceId: note.id,
                                        path: dstuPath,
                                        name: note.title,
                                        type: 'note',
                                        size: note.content_md?.length || 0,
                                        createdAt: new Date(note.created_at).getTime(),
                                        updatedAt: new Date(note.updated_at).getTime(),
                                        previewType: 'markdown',
                                    };
                                    await openResource(dstuNode);
                                } catch (err: unknown) {
                                    // openResource handler 未注册时，回退到旧逻辑
                                    console.log('[NotesSidebar] openResource fallback:', err);
                                    setActive(note);
                                    void ensureNoteContent(note.id);
                                }
                            }}
                            expandedIds={expandedIds}
                            onExpand={(id) => {
                                setExpandedIds(prev => [...prev, id]);
                                // ★ Prompt 10: 展开文件夹时异步校验文件夹下的引用
                                const folder = folders[id];
                                if (folder?.children) {
                                    const refIds = folder.children.filter(isReferenceId);
                                    if (refIds.length > 0) {
                                        void batchValidateReferences(refIds);
                                    }
                                }
                            }}
                            onCollapse={(id) => setExpandedIds(prev => prev.filter(p => p !== id))}
                            searchTerm={isSearching ? "searching..." : ""}
                            onDrop={handleDrop}
                            renamingId={renamingId}
                            onRename={(id, name) => {
                                renameItem(id, name);
                                setRenamingId(null);
                            }}
                            onDelete={(ids) => deleteItems(ids)}
                            onContextMenu={handleContextMenu}
                            disableDrag={showFavoritesOnly}
                        />
                    </CustomScrollArea>
                )}
            </div>

            {/* Context Menu - 使用 Portal 渲染到 body，避免父元素样式影响定位 */}
            <NotionDialog
                open={referenceDialog.open}
                onOpenChange={(open) => {
                    if (!open) closeReferenceDialog();
                }}
                maxWidth="max-w-md"
            >
                <NotionDialogHeader>
                    <NotionDialogTitle>{referenceDialogTitle}</NotionDialogTitle>
                </NotionDialogHeader>
                <NotionDialogBody nativeScroll>
                    <div className="space-y-2">
                        <Input
                            value={referenceValue}
                            onChange={(e) => setReferenceValue(e.target.value)}
                            placeholder={referenceDialogPlaceholder}
                            className="h-9"
                            autoFocus
                        />
                    </div>
                </NotionDialogBody>
                <NotionDialogFooter>
                    <NotionButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={closeReferenceDialog}
                        disabled={referenceSubmitting}
                    >
                        {t('common:actions.cancel')}
                    </NotionButton>
                    <NotionButton
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={submitReference}
                        disabled={referenceSubmitting || referenceValue.trim().length === 0}
                    >
                        {t('common:actions.confirm')}
                    </NotionButton>
                </NotionDialogFooter>
            </NotionDialog>

            {contextMenu && createPortal(
                <>
                    {/* 点击遮罩关闭菜单 */}
                    <div 
                        className="fixed inset-0" 
                        style={{ zIndex: Z_INDEX.contextMenuBackdrop }}
                        onClick={() => setContextMenu(null)}
                        onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
                    />
                    <div
                        className="app-menu-content fixed"
                        style={{ left: contextMenu.x, top: contextMenu.y, zIndex: Z_INDEX.contextMenu }}
                    >
                        {/* ★ Prompt 8: DSTU 菜单项 */}
                        {buildDstuMenuItems(contextMenu.id).map((item) => {
                            if (item.type === 'separator') {
                                return <div key={item.id} className="app-menu-separator" />;
                            }
                            return (
                                <NotionButton
                                    key={item.id}
                                    variant="ghost" size="sm"
                                    className="app-menu-item"
                                    onClick={async () => {
                                        if (item.action) await item.action();
                                        setContextMenu(null);
                                    }}
                                >
                                    <span className="app-menu-item-content">
                                        {t(item.label, item.label)}
                                    </span>
                                </NotionButton>
                            );
                        })}
                        
                        {/* 收藏/取消收藏 - 仅对笔记显示 */}
                        {(() => {
                            const note = notes.find(n => n.id === contextMenu.id);
                            if (!note) return null;
                            return (
                                <NotionButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { toggleFavorite(contextMenu.id); setContextMenu(null); }}>
                                    <span className="app-menu-item-icon">
                                        <Star className={cn("h-4 w-4", note.is_favorite && "fill-warning text-warning")} />
                                    </span>
                                    <span className="app-menu-item-content">
                                        {note.is_favorite 
                                            ? t('notes:favorites.context_unmark') 
                                            : t('notes:favorites.context_mark')
                                        }
                                    </span>
                                </NotionButton>
                            );
                        })()}
                        {treeData[contextMenu.id]?.canRename !== false && (
                            <NotionButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { setRenamingId(contextMenu.id); setContextMenu(null); }}>
                                <span className="app-menu-item-content">
                                    {t('notes:tree.context_menu.rename')}
                                </span>
                            </NotionButton>
                        )}
                        
                        {/* ★ 引用操作（Prompt 6）- 仅对文件夹显示添加引用选项 */}
                        {treeData[contextMenu.id]?.isFolder && (
                            <>
                                <div className="app-menu-separator" />
                                <NotionButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { openReferenceDialog('textbook', contextMenu.id); setContextMenu(null); }}>
                                    <span className="app-menu-item-icon">
                                        <BookOpen className="h-4 w-4" />
                                    </span>
                                    <span className="app-menu-item-content">
                                        {t('notes:reference.add_textbook')}
                                    </span>
                                </NotionButton>
                            </>
                        )}
                        
                        {/* ★ 引用节点的删除选项 - 使用 removeRef 而不是 deleteItems */}
                        {isReferenceId(contextMenu.id) ? (
                            <NotionButton variant="ghost" size="sm" className="app-menu-item app-menu-item-destructive" onClick={() => { removeRef(contextMenu.id); setContextMenu(null); }}>
                                <span className="app-menu-item-icon">
                                    <Link className="h-4 w-4" />
                                </span>
                                <span className="app-menu-item-content">
                                    {t('notes:reference.remove')}
                                </span>
                            </NotionButton>
                        ) : (
                            <NotionButton variant="ghost" size="sm" className="app-menu-item app-menu-item-destructive" onClick={() => { deleteItems([contextMenu.id]); setContextMenu(null); }}>
                                <span className="app-menu-item-icon">
                                    <Trash2 className="h-4 w-4" />
                                </span>
                                <span className="app-menu-item-content">
                                    {t('notes:tree.context_menu.delete')}
                                </span>
                            </NotionButton>
                        )}
                    </div>
                </>,
                document.body
            )}

        </div>
    );
};
