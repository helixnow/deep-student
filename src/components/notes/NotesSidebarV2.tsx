/**
 * NotesSidebarV2 - 笔记侧边栏（使用 UnifiedSidebar 容器）
 * 
 * 使用 UnifiedSidebar 作为容器和头部，保留专用的 DndFileTree 内容区域
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Trash2,
  Folder,
  FolderPlus,
  Star,
  BookOpen,
  Link,
  FileText,
} from "lucide-react";
import { NotionButton } from '@/components/ui/NotionButton';
import { Z_INDEX } from '@/config/zIndex';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody, NotionDialogFooter } from '../ui/NotionDialog';
import { Input } from "../ui/shad/Input";
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
  AppMenuSeparator,
} from "../ui/app-menu";
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  useUnifiedSidebar,
} from "@/components/ui/unified-sidebar";
import { DndFileTree, type TreeData, type DragInfo } from "./DndFileTree";
import { useNotes } from "./NotesContext";
import { buildTreeData, getPathToNote } from "./notesUtils";
import { cn } from "../../lib/utils";
import { NotesSidebarSearch } from "./components/NotesSidebarSearch";
import { AddReferenceDropdown } from "./components/AddReferenceDropdown";
import { invoke } from '@tauri-apps/api/core';
import { isReferenceId } from "./types/reference";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CustomScrollArea } from "../custom-scroll-area";
import { openResource, buildContextMenu } from "@/dstu";
import type { DstuNode } from "@/dstu/types";
import type { ContextMenuItem } from "@/dstu/editorTypes";
import { showGlobalNotification } from "../UnifiedNotification";

const stripHtml = (raw: string) => raw.replace(/<[^>]*>/g, '');

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

const NotesSidebarContent: React.FC = () => {
  const { t } = useTranslation(['notes', 'common']);
  const { searchQuery } = useUnifiedSidebar();
  
  const {
    notes,
    folders,
    rootChildren,
    loading,
    active,
    setActive,
    refreshNotes,
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
      if (e.key === 'Escape') setContextMenu(null);
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
      console.error('[NotesSidebarV2] Failed to add reference', error);
      showGlobalNotification('error', t('notes:reference.add_failed'));
      setReferenceSubmitting(false);
    }
  }, [referenceDialog, referenceSubmitting, referenceValue, addTextbookRef, closeReferenceDialog, t]);

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
    const menuWidth = 160;
    const menuHeight = 120;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setContextMenu({ x, y, id });
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

  const showSearchResults = Boolean(contextSearchQuery && (isSearching || searchResults.length > 0));

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

  const referenceDialogTitle = t('notes:reference.add_textbook');
  const referenceDialogPlaceholder = t('notes:reference.enter_textbook_id');

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="p-3 pb-0 space-y-3">
        <div className="flex items-center gap-1 min-h-[36px]">
          <NotionButton 
            variant="ghost" 
            size="icon"
            className="h-8 w-8 text-muted-foreground/70 hover:text-foreground"
            onClick={handleCreateNote}
            title={t('notes:sidebar.actions.new_note')}
          >
            <FileText className="h-4 w-4" />
          </NotionButton>
          <NotionButton 
            variant="ghost" 
            size="icon"
            className="h-8 w-8 text-muted-foreground/70 hover:text-foreground"
            onClick={handleCreateFolder}
            title={t('notes:sidebar.actions.new_folder')}
          >
            <FolderPlus className="h-4 w-4" />
          </NotionButton>
          <NotionButton 
            variant="ghost" 
            size="icon"
            className={cn(
              "h-8 w-8 hover:text-foreground",
              showFavoritesOnly ? "text-warning hover:text-warning/80" : "text-muted-foreground/70"
            )}
            onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
            title={showFavoritesOnly 
              ? t('notes:sidebar.actions.favorites_filter_off') 
              : t('notes:sidebar.actions.favorites_filter_on')
            }
          >
            <Star className={cn("h-3.5 w-3.5", showFavoritesOnly && "fill-current")} />
          </NotionButton>

          <AddReferenceDropdown
            selectedFolderId={
              selectedNodeId && treeData[selectedNodeId]?.isFolder ? selectedNodeId : undefined
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
        </div>
        
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
        {(loading || (isSearching && searchResults.length === 0 && contextSearchQuery)) ? (
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
                if (isReferenceId(id)) void validateReference(id);
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

      {/* Context Menu */}
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
          <div 
            className="fixed inset-0" 
            style={{ zIndex: Z_INDEX.contextMenuBackdrop }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div className="app-menu-content fixed" style={{ left: contextMenu.x, top: contextMenu.y, zIndex: Z_INDEX.contextMenu }}>
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
                  <span className="app-menu-item-content">{t(item.label, item.label)}</span>
                </NotionButton>
              );
            })}
            
            {/* 收藏/取消收藏 */}
            {(() => {
              const note = notes.find(n => n.id === contextMenu.id);
              if (!note) return null;
              return (
                <NotionButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { toggleFavorite(contextMenu.id); setContextMenu(null); }}>
                  <span className="app-menu-item-icon">
                    <Star className={cn("h-4 w-4", note.is_favorite && "fill-warning text-warning")} />
                  </span>
                  <span className="app-menu-item-content">
                    {note.is_favorite ? t('notes:favorites.context_unmark') : t('notes:favorites.context_mark')}
                  </span>
                </NotionButton>
              );
            })()}
            
            {treeData[contextMenu.id]?.canRename !== false && (
              <NotionButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { setRenamingId(contextMenu.id); setContextMenu(null); }}>
                <span className="app-menu-item-content">{t('notes:tree.context_menu.rename')}</span>
              </NotionButton>
            )}
            
            {/* 引用操作 */}
            {treeData[contextMenu.id]?.isFolder && (
              <>
                <div className="app-menu-separator" />
                <NotionButton variant="ghost" size="sm" className="app-menu-item" onClick={() => { openReferenceDialog('textbook', contextMenu.id); setContextMenu(null); }}>
                  <span className="app-menu-item-icon"><BookOpen className="h-4 w-4" /></span>
                  <span className="app-menu-item-content">{t('notes:reference.add_textbook')}</span>
                </NotionButton>
              </>
            )}
            
            {/* 删除 */}
            {isReferenceId(contextMenu.id) ? (
              <NotionButton variant="ghost" size="sm" className="app-menu-item app-menu-item-destructive" onClick={() => { removeRef(contextMenu.id); setContextMenu(null); }}>
                <span className="app-menu-item-icon"><Link className="h-4 w-4" /></span>
                <span className="app-menu-item-content">{t('notes:reference.remove')}</span>
              </NotionButton>
            ) : (
              <NotionButton variant="ghost" size="sm" className="app-menu-item app-menu-item-destructive" onClick={() => { deleteItems([contextMenu.id]); setContextMenu(null); }}>
                <span className="app-menu-item-icon"><Trash2 className="h-4 w-4" /></span>
                <span className="app-menu-item-content">{t('notes:tree.context_menu.delete')}</span>
              </NotionButton>
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

  return (
    <UnifiedSidebar
      className={className}
      autoResponsive={autoResponsive}
      displayMode={displayMode}
      drawerSide="left"
      mobileOpen={mobileOpen}
      onMobileOpenChange={onMobileOpenChange}
      width={width}
      onClose={onClose}
    >
      <UnifiedSidebarHeader
        title={t('notes:sidebar.title')}
        icon={FileText}
        showSearch
        searchPlaceholder={t('notes:search.placeholder')}
        showRefresh
        refreshTitle={t('notes:sidebar.actions.refresh')}
        onRefreshClick={() => refreshNotes()}
        showCollapse
        rightActions={
          <NotionButton
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setTrashOpen(true)}
            title={t('notes:sidebar.trash')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </NotionButton>
        }
      />
      <NotesSidebarContent />
    </UnifiedSidebar>
  );
};

export default NotesSidebarV2;
