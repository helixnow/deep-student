/**
 * NotesSidebarV2 - 笔记侧边栏（使用 UnifiedSidebar 容器）
 * 
 * 使用 UnifiedSidebar 作为容器和头部，保留专用的 DndFileTree 内容区域
 */

import React, { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Trash,
  Folder,
  FolderPlus,
  Star,
  BookOpen,
  Link,
  FileText,
  PencilSimple,
} from "@phosphor-icons/react";
import { DsButton } from '@/components/ui/DsButton';
import { Z_INDEX } from '@/config/zIndex';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
  AppMenuSeparator,
} from "@/components/ui/app-menu";
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
} from "@/components/ui/unified-sidebar";
import { DndFileTree, type TreeData, type DragInfo } from "./DndFileTree";
import { useNotes } from "./NotesContext";
import { buildTreeData, getPathToNote } from "./notesUtils";
import { cn } from "../../lib/utils";
import { NotesSidebarSearch } from "./components/NotesSidebarSearch";
import { AddReferenceDropdown } from "./components/AddReferenceDropdown";
import { ReferenceSelector, type ReferenceSelectResult } from "./reference-selector";
import { invoke } from '@tauri-apps/api/core';
import { isReferenceId } from "./types/reference";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CustomScrollArea } from "@/components/custom-scroll-area";
import { openResource, buildContextMenu } from "@/dstu";
import type { DstuNode } from "@/dstu/types";
import type { ContextMenuItem } from "@/dstu/editorTypes";
import { showGlobalNotification } from "@/components/UnifiedNotification";
import { useBreakpoint } from "@/hooks/useBreakpoint";

const stripHtml = (raw: string) => raw.replace(/<[^>]*>/g, '');

/** 骨架屏行条：替代 daisyUI spinner，与全局 简洁风格一致 */
const SidebarSkeletonRows: React.FC<{ rows?: number }> = ({ rows = 8 }) => (
  <div className="absolute inset-0 px-3 py-2 space-y-2 overflow-hidden" aria-hidden="true">
    {Array.from({ length: rows }).map((_, i) => (
      <div
        key={i}
        className="h-6 rounded-md bg-muted/40 animate-pulse"
        style={{ width: `${88 - ((i * 19) % 42)}%` }}
      />
    ))}
  </div>
);

interface NotesSidebarV2Props {
  className?: string;
  /** 是否启用自动响应式（移动端自动切换为 drawer 模式），默认 true */
  autoResponsive?: boolean;
  /** 显示模式：panel（面板）或 drawer（抽屉），默认 drawer */
  displayMode?: 'panel' | 'drawer';
  /** 移动端是否打开（用于外部控制 drawer） */
  mobileOpen?: boolean;
  /** 移动端打开状态变化回调 */
  onMobileOpenChange?: (open: boolean) => void;
  /** 侧边栏宽度，设置为 'full' 时填满容器 */
  width?: number | 'full';
  /** 关闭回调（用于移动滑动模式） */
  onClose?: () => void;
}

// ============================================================================
// 内部组件：笔记列表内容
// ============================================================================

const NotesSidebarContent: React.FC<{
  /** 选中笔记后关闭侧栏（移动推拉布局；P1-11 选笔记直达编辑器） */
  onNoteSelected?: () => void;
}> = ({ onNoteSelected }) => {
  const { t } = useTranslation(['notes', 'common']);

  const {
    notes,
    folders,
    rootChildren,
    loading,
    active,
    setActive,
    createNote,
    createFolder,
    moveItem,
    renameItem,
    deleteItems,
    toggleFavorite,
    searchResults,
    isSearching,
    searchQuery: contextSearchQuery,
    ensureNoteContent,
    references,
    addTextbookRef,
    removeRef,
    validateReference,
    batchValidateReferences,
  } = useNotes();

  const [sortMethod, setSortMethod] = useState("name_asc");
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  // 右键菜单「添加教材引用」：复用 ReferenceSelector 非模态内联面板（无锚点回退顶部居中）
  const [folderRefPicker, setFolderRefPicker] = useState<{
    open: boolean;
    folderId: string | null;
  }>({ open: false, folderId: null });
  // 搜索结果键盘导航：当前高亮索引（-1 = 未选中）
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const searchListRef = useRef<HTMLDivElement>(null);
  const treeViewportRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // 展开状态持久化：磁盘偏好加载完成前禁止回写
  const expandedPrefLoadedRef = useRef(false);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      setContextMenuPosition(null);
      return;
    }
    const menu = contextMenuRef.current;
    const maxX = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
    const maxY = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
    const x = Math.min(Math.max(contextMenu.x, 8), maxX);
    const y = Math.min(Math.max(contextMenu.y, 8), maxY);
    setContextMenuPosition((current) => current?.x === x && current.y === y ? current : { x, y });
  }, [contextMenu]);

  // ESC 键关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [contextMenu]);

  const openFolderRefPicker = useCallback((folderId: string) => {
    setFolderRefPicker({ open: true, folderId });
  }, []);

  const setFolderRefPickerOpen = useCallback((open: boolean) => {
    setFolderRefPicker(prev => (open ? { ...prev, open: true } : { open: false, folderId: null }));
  }, []);

  // 已存在的引用（选择器中禁用已引用的教材）
  const existingRefs = useMemo(
    () => Object.values(references).map(ref => ({ sourceDb: ref.sourceDb, sourceId: ref.sourceId })),
    [references]
  );

  const handleFolderRefSelect = useCallback(async (result: ReferenceSelectResult) => {
    const folderId = folderRefPicker.folderId ?? undefined;
    try {
      await addTextbookRef(result.sourceId, folderId);
    } catch (error: unknown) {
      console.error('[NotesSidebarV2] Failed to add reference', error);
      showGlobalNotification('error', t('notes:reference.add_failed'));
    }
  }, [folderRefPicker.folderId, addTextbookRef, t]);

  // Virtualizer for search results
  const rowVirtualizer = useVirtualizer({
    count: searchResults.length,
    getScrollElement: () => searchListRef.current,
    estimateSize: () => 60,
    overscan: 5,
  });

  // Handle external reveal request
  const { sidebarRevealId, setSidebarRevealId } = useNotes();

  useEffect(() => {
    if (sidebarRevealId) {
      setSelectedNodeId(sidebarRevealId);
      const path = getPathToNote(sidebarRevealId, folders, notes);
      const parentIds = path.slice(0, -1).map(p => p.id);
      if (parentIds.length > 0) {
        setExpandedIds(prev => Array.from(new Set([...prev, ...parentIds])));
      }
      setSidebarRevealId(null);
    }
  }, [sidebarRevealId, folders, notes, setSidebarRevealId]);

  // 筛选后的笔记列表
  const filteredNotes = useMemo(() => {
    if (!showFavoritesOnly) return notes;
    return notes.filter(n => n.is_favorite);
  }, [notes, showFavoritesOnly]);

  const treeData: TreeData = useMemo(() => {
    return buildTreeData({
      notes: filteredNotes,
      folders: showFavoritesOnly ? {} : folders,
      rootChildren: showFavoritesOnly ? filteredNotes.map(n => n.id) : rootChildren,
      noteRootLabel: showFavoritesOnly 
        ? t('notes:sidebar.favorites.title') 
        : t('notes:common.noteRoot'),
      untitledLabel: t('notes:common.untitled'),
      sortMethod
    });
  }, [filteredNotes, folders, rootChildren, sortMethod, showFavoritesOnly, t]);

  // Sync selection with active note
  useEffect(() => {
    if (active) setSelectedNodeId(active.id);
  }, [active]);

  const handleCreateNote = async () => {
    let parentId: string | undefined;
    if (selectedNodeId) {
      const node = treeData[selectedNodeId];
      if (node) {
        if (node.isFolder) {
          parentId = selectedNodeId;
        } else {
          const pid = node.data?.parentId;
          if (pid && pid !== 'root') parentId = pid;
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
          if (pid && pid !== 'root') parentId = pid;
        }
      }
    }
    const id = await createFolder(parentId);
    if (id) setRenamingId(id);
  };

  const handleContextMenu = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedNodeId(id);
    setContextMenu({ x: e.clientX, y: e.clientY, id });
  }, []);

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
      index = treeData[targetId].children?.length || 0;
    } else {
      parentId = targetNode.data?.parentId || null;
      if (parentId === 'root') parentId = null;
      const parentChildren = parentId ? treeData[parentId]?.children : treeData['root']?.children;
      if (parentChildren) {
        const targetIndex = parentChildren.indexOf(targetId);
        index = position === 'after' ? targetIndex + 1 : targetIndex;
      }
    }
    moveItem(draggedIds, parentId, index);
  }, [treeData, moveItem]);

  // 只要有搜索词就进入搜索视图；加载中/无结果/有结果三种子状态在渲染处区分
  const hasSearchQuery = Boolean((contextSearchQuery || '').trim());

  const renderHighlight = useCallback((raw: string) => {
    const q = (contextSearchQuery || '').trim();
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
  }, [contextSearchQuery]);

  useEffect(() => {
    const loadSortPref = async () => {
      const v = await invoke<string | null>('notes_get_pref', { key: 'notes_sort:default' });
      if (typeof v === 'string' && v) setSortMethod(v);
    };
    void loadSortPref();
  }, []);

  const changeSort = async (next: string) => {
    setSortMethod(next);
    await invoke<boolean>('notes_set_pref', { key: 'notes_sort:default', value: next });
  };

  // 文件树展开状态持久化：启动时恢复，变化时回写（加载完成前不写，避免覆盖磁盘偏好）
  useEffect(() => {
    let cancelled = false;
    const loadExpandedPref = async () => {
      try {
        const raw = await invoke<string | null>('notes_get_pref', { key: 'notes_tree_expanded:default' });
        if (!cancelled && raw) {
          const ids = JSON.parse(raw);
          if (Array.isArray(ids)) {
            setExpandedIds(prev => Array.from(new Set([...prev, ...ids.filter((id): id is string => typeof id === 'string')])));
          }
        }
      } catch {
      } finally {
        if (!cancelled) expandedPrefLoadedRef.current = true;
      }
    };
    void loadExpandedPref();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!expandedPrefLoadedRef.current) return;
    void invoke<boolean>('notes_set_pref', {
      key: 'notes_tree_expanded:default',
      value: JSON.stringify(expandedIds),
    });
  }, [expandedIds]);

  // 打开一条搜索结果（点击与键盘 Enter 共用）
  const openSearchResult = useCallback((resultId: string) => {
    const note = notes.find(n => n.id === resultId);
    if (note) setActive(note);
    void ensureNoteContent(resultId);
    if (note) onNoteSelected?.();
  }, [notes, setActive, ensureNoteContent, onNoteSelected]);

  // 搜索词变化时重置键盘高亮
  useEffect(() => {
    setActiveResultIndex(-1);
  }, [contextSearchQuery]);

  const handleResultNavigate = useCallback((delta: 1 | -1) => {
    if (searchResults.length === 0) return;
    setActiveResultIndex(prev => {
      const next = prev === -1
        ? (delta === 1 ? 0 : searchResults.length - 1)
        : Math.min(Math.max(prev + delta, 0), searchResults.length - 1);
      rowVirtualizer.scrollToIndex(next);
      return next;
    });
  }, [searchResults.length, rowVirtualizer]);

  const handleResultSubmit = useCallback(() => {
    if (searchResults.length === 0) return;
    const index = activeResultIndex === -1 ? 0 : activeResultIndex;
    const res = searchResults[index];
    if (res) openSearchResult(res.id);
  }, [searchResults, activeResultIndex, openSearchResult]);

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="p-3 pb-0 space-y-3">
        <div className="flex items-center gap-1 min-h-[36px]">
          {/* 触屏（pointer:coarse）下放大到 40px 触控目标 */}
          <DsButton 
            variant="ghost" 
            size="icon"
            className="h-8 w-8 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 text-muted-foreground/70 hover:text-foreground"
            onClick={handleCreateNote}
            title={t('notes:sidebar.actions.new_note')}
          >
            <FileText className="h-4 w-4" />
          </DsButton>
          <DsButton 
            variant="ghost" 
            size="icon"
            className="h-8 w-8 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 text-muted-foreground/70 hover:text-foreground"
            onClick={handleCreateFolder}
            title={t('notes:sidebar.actions.new_folder')}
          >
            <FolderPlus className="h-4 w-4" />
          </DsButton>
          <DsButton 
            variant="ghost" 
            size="icon"
            className={cn(
              "h-8 w-8 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 hover:text-foreground",
              showFavoritesOnly ? "text-warning hover:text-warning/80" : "text-muted-foreground/70"
            )}
            onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
            title={showFavoritesOnly 
              ? t('notes:sidebar.actions.favorites_filter_off') 
              : t('notes:sidebar.actions.favorites_filter_on')
            }
          >
            <Star className={cn("h-3.5 w-3.5", showFavoritesOnly && "fill-current")} />
          </DsButton>

          <AddReferenceDropdown
            selectedFolderId={
              selectedNodeId && treeData[selectedNodeId]?.isFolder ? selectedNodeId : undefined
            }
            compact
          />

          <AppMenu>
            <AppMenuTrigger asChild>
              <DsButton 
                variant="ghost" 
                size="sm"
                className="h-8 [@media(pointer:coarse)]:h-10 px-2 text-[11px] text-muted-foreground/70 hover:text-foreground"
                title={t('notes:sidebar.actions.sort')}
              >
                {/* 显示当前排序方式，而非写死首项 */}
                {t(`notes:sidebar.actions.sort_${sortMethod}`, t('notes:sidebar.actions.sort'))}
              </DsButton>
            </AppMenuTrigger>
            <AppMenuContent align="start" width={160}>
              <AppMenuItem checked={sortMethod === 'name_asc'} onClick={() => changeSort('name_asc')}>{t('notes:sidebar.actions.sort_name_asc')}</AppMenuItem>
              <AppMenuItem checked={sortMethod === 'name_desc'} onClick={() => changeSort('name_desc')}>{t('notes:sidebar.actions.sort_name_desc')}</AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem checked={sortMethod === 'modified_desc'} onClick={() => changeSort('modified_desc')}>{t('notes:sidebar.actions.sort_modified_desc')}</AppMenuItem>
              <AppMenuItem checked={sortMethod === 'modified_asc'} onClick={() => changeSort('modified_asc')}>{t('notes:sidebar.actions.sort_modified_asc')}</AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem checked={sortMethod === 'created_desc'} onClick={() => changeSort('created_desc')}>{t('notes:sidebar.actions.sort_created_desc')}</AppMenuItem>
              <AppMenuItem checked={sortMethod === 'created_asc'} onClick={() => changeSort('created_asc')}>{t('notes:sidebar.actions.sort_created_asc')}</AppMenuItem>
            </AppMenuContent>
          </AppMenu>
        </div>
        
        <NotesSidebarSearch
          onResultNavigate={handleResultNavigate}
          onResultSubmit={handleResultSubmit}
        />
      </div>
      
      {/* Section Divider */}
      <div className="px-3 py-2">
        <div className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider pl-2 flex items-center justify-between">
          <span>{t('notes:tree.root')}</span>
        </div>
      </div>

      {/* Tree Area */}
      <div className="flex-1 min-h-0 relative" onContextMenu={(e) => e.preventDefault()}>
        {loading ? (
          <SidebarSkeletonRows />
        ) : hasSearchQuery ? (
          isSearching && searchResults.length === 0 ? (
            <SidebarSkeletonRows rows={5} />
          ) : searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center">
              <p className="text-sm text-muted-foreground">
                {t('notes:search.no_results')}
              </p>
            </div>
          ) : (
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
                const isKeyboardActive = virtualRow.index === activeResultIndex;

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
                      className={cn(
                        "sidebar-shell-item p-2 cursor-pointer text-sm group transition-colors h-full",
                        isKeyboardActive && "bg-[var(--interactive-hover)] ring-1 ring-inset ring-[hsl(var(--ring)/0.4)]"
                      )}
                      onClick={() => openSearchResult(res.id)}
                      onMouseEnter={() => setActiveResultIndex(virtualRow.index)}
                    >
                      <div className="font-medium truncate text-foreground/80 group-hover:text-foreground">
                        {renderHighlight(res.title)}
                      </div>
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
          )
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
        ) : notes.length === 0 && rootChildren.length === 0 ? (
          /* 空库引导：提供创建 CTA，而非裸「暂无数据」 */
          <div className="flex flex-col items-center justify-center h-full p-4 text-center ui-rise-in">
            <FileText className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground mb-3">
              {t('notes:tree.empty')}
            </p>
            <div className="flex items-center gap-2">
              <DsButton variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={handleCreateNote}>
                <FileText className="h-3.5 w-3.5 mr-1" />
                {t('notes:sidebar.actions.new_note')}
              </DsButton>
              <DsButton variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={handleCreateFolder}>
                <FolderPlus className="h-3.5 w-3.5 mr-1" />
                {t('notes:sidebar.actions.new_folder')}
              </DsButton>
            </div>
          </div>
        ) : (
          <CustomScrollArea
            className="h-full"
            viewportRef={treeViewportRef}
            viewportClassName="pl-1 pr-1"
          >
            <DndFileTree
              scrollViewportRef={treeViewportRef}
              treeData={treeData}
              selectedIds={selectedIds}
              onSelect={(ids) => {
                const id = ids[0];
                setSelectedNodeId(id);
                const note = notes.find(n => n.id === id);
                if (note) setActive(note);
                if (note) void ensureNoteContent(note.id);
                if (isReferenceId(id)) void validateReference(id);
                // 选中的是笔记（非文件夹/引用）时收起移动侧栏，直达编辑器
                if (note) onNoteSelected?.();
              }}
              onDoubleClick={async (id) => {
                if (isReferenceId(id)) return;
                const note = notes.find(n => n.id === id);
                if (!note) return;
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
                } catch {
                  setActive(note);
                  void ensureNoteContent(note.id);
                }
              }}
              expandedIds={expandedIds}
              onExpand={(id) => {
                setExpandedIds(prev => [...prev, id]);
                const folder = folders[id];
                if (folder?.children) {
                  const refIds = folder.children.filter(isReferenceId);
                  if (refIds.length > 0) void batchValidateReferences(refIds);
                }
              }}
              onCollapse={(id) => setExpandedIds(prev => prev.filter(p => p !== id))}
              onDrop={handleDrop}
              renamingId={renamingId}
              onRename={(id, name) => {
                renameItem(id, name);
                setRenamingId(null);
              }}
              onDelete={(ids) => deleteItems(ids)}
              onContextMenu={handleContextMenu}
              onCreateChild={async (folderId) => {
                setExpandedIds(prev => prev.includes(folderId) ? prev : [...prev, folderId]);
                const id = await createNote(folderId);
                if (id) setRenamingId(id);
              }}
              disableDrag={showFavoritesOnly}
            />
          </CustomScrollArea>
        )}
      </div>

      {/* 右键菜单「添加教材引用」内联选择面板（非模态，无锚点回退顶部居中） */}
      <ReferenceSelector
        open={folderRefPicker.open}
        onOpenChange={setFolderRefPickerOpen}
        type="textbook"
        onSelect={handleFolderRefSelect}
        existingRefs={existingRefs}
        hint={folderRefPicker.folderId
          ? t('notes:reference.add_to_folder')
          : t('notes:reference.add_to_root')}
      />

      {contextMenu && createPortal(
        <>
          <div 
            className="fixed inset-0" 
            style={{ zIndex: Z_INDEX.contextMenuBackdrop }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div
            ref={contextMenuRef}
            className="app-menu-content notes-tree-context-menu ui-zoom-fade-in fixed"
            role="menu"
            aria-label={t('notes:tree.aria.tree')}
            style={{
              left: (contextMenuPosition ?? contextMenu).x,
              top: (contextMenuPosition ?? contextMenu).y,
              visibility: contextMenuPosition ? 'visible' : 'hidden',
              zIndex: Z_INDEX.contextMenu,
            }}
          >
            {buildDstuMenuItems(contextMenu.id).map((item) => {
              if (item.type === 'separator') {
                return <div key={item.id} className="app-menu-separator" />;
              }
              return (
                <DsButton
                  key={item.id}
                  variant="ghost" size="sm"
                  className="app-menu-item"
                  onClick={async () => {
                    if (item.action) await item.action();
                    setContextMenu(null);
                  }}
                >
                  <span className="app-menu-item-content">{t(item.label, item.label)}</span>
                </DsButton>
              );
            })}
            
            {/* 收藏/取消收藏 */}
            {(() => {
              const note = notes.find(n => n.id === contextMenu.id);
              if (!note) return null;
              return (
                <DsButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { toggleFavorite(contextMenu.id); setContextMenu(null); }}>
                  <span className="app-menu-item-icon">
                    <Star className={cn("h-4 w-4", note.is_favorite && "fill-warning text-warning")} />
                  </span>
                  <span className="app-menu-item-content">
                    {note.is_favorite ? t('notes:favorites.context_unmark') : t('notes:favorites.context_mark')}
                  </span>
                </DsButton>
              );
            })()}
            
            {treeData[contextMenu.id]?.canRename !== false && (
              <DsButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { setRenamingId(contextMenu.id); setContextMenu(null); }}>
                <span className="app-menu-item-icon"><PencilSimple className="h-4 w-4" /></span>
                <span className="app-menu-item-content">{t('notes:tree.context_menu.rename')}</span>
              </DsButton>
            )}
            
            {/* 引用操作 */}
            {treeData[contextMenu.id]?.isFolder && (
              <>
                <div className="app-menu-separator" />
                <DsButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { openFolderRefPicker(contextMenu.id); setContextMenu(null); }}>
                  <span className="app-menu-item-icon"><BookOpen className="h-4 w-4" /></span>
                  <span className="app-menu-item-content">{t('notes:reference.add_textbook')}</span>
                </DsButton>
              </>
            )}
            
            {/* 删除 */}
            {isReferenceId(contextMenu.id) ? (
              <DsButton variant="ghost" size="sm" className="app-menu-item app-menu-item-destructive" onClick={() => { removeRef(contextMenu.id); setContextMenu(null); }}>
                <span className="app-menu-item-icon"><Link className="h-4 w-4" /></span>
                <span className="app-menu-item-content">{t('notes:reference.remove')}</span>
              </DsButton>
            ) : (
              <DsButton variant="ghost" size="sm" className="app-menu-item app-menu-item-destructive" onClick={() => { deleteItems([contextMenu.id]); setContextMenu(null); }}>
                <span className="app-menu-item-icon"><Trash size={16} /></span>
                <span className="app-menu-item-content">{t('notes:tree.context_menu.delete')}</span>
              </DsButton>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const NotesSidebarV2: React.FC<NotesSidebarV2Props> = ({
  className,
  autoResponsive = true,
  displayMode = 'drawer',
  mobileOpen,
  onMobileOpenChange,
  width,
  onClose,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const { refreshNotes, setTrashOpen } = useNotes();
  const { isSmallScreen } = useBreakpoint();

  return (
    <UnifiedSidebar
      className={cn('study-shell-sidebar-frame', className)}
      autoResponsive={autoResponsive}
      displayMode={displayMode}
      drawerSide="left"
      mobileOpen={mobileOpen}
      onMobileOpenChange={onMobileOpenChange}
      width={width}
      onClose={onClose}
    >
      {/* 头部搜索关闭：与 NotesSidebarSearch 并存会形成第二个断连的搜索框 */}
      <UnifiedSidebarHeader
        title={t('notes:sidebar.title')}
        icon={FileText}
        showSearch={false}
        showRefresh
        refreshTitle={t('notes:sidebar.actions.refresh')}
        onRefreshClick={() => refreshNotes()}
        showCollapse={!isSmallScreen}
        rightActions={
          <DsButton
            variant="utility"
            size="icon"
            className="h-7 w-7"
            onClick={() => setTrashOpen(true)}
            title={t('notes:sidebar.trash')}
          >
            <Trash size={14} />
          </DsButton>
        }
      />
      <NotesSidebarContent onNoteSelected={isSmallScreen ? onClose : undefined} />
    </UnifiedSidebar>
  );
};

export default NotesSidebarV2;
