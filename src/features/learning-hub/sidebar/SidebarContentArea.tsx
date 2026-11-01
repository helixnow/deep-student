import type React from 'react';
import { lazy, Suspense } from 'react';
import { CircleNotch, ListBullets, XCircle } from '@phosphor-icons/react';
import { dstu, createEmpty, type DstuNode } from '@/dstu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { NoteLearningViews } from '@/features/notes/components/NoteLearningViews';
import { MemoryFolderBanner } from '../components/MemoryFolderBanner';
import { MemoryTreePreview } from '../components/MemoryTreePreview';
import {
  FinderFileList,
  DesktopView,
  type CreateResourceType,
} from '../components/finder';
import {
  FinderViewTabs,
  NotesLearningViewTabs,
  type NotesLearningFinderView,
} from '../components/finder/NotesLearningViewTabs';
import type { ExamsFinderView } from '../mistakeBook/mistakeBookNavigation';
import type { DesktopRootConfig } from '../stores/desktopStore';
import type { FinderPath, InlineEditState, QuickAccessType, ViewMode } from '../stores/finderStore';
import { dstuNodeToResourceListItem } from '../types';
import type { LearningHubSidebarProps } from '../types';
import type { EffectiveFinderPath, SidebarT } from './sidebarConstants';
import type { OpenHandlers } from './openHandlers';
import type { useDropTargets } from './useDropTargets';

// 懒加载向量化状态视图
const IndexStatusView = lazy(() => import('../views/IndexStatusGate'));
// ★ 2026-01-19: 懒加载 VFS 记忆管理视图
const MemoryView = lazy(() => import('../views/MemoryView'));

const MistakeBookView = lazy(() =>
  import('../mistakeBook/MistakeBookView').then((module) => ({ default: module.MistakeBookView })),
);

type DropTargets = ReturnType<typeof useDropTargets>;

export interface SidebarContentAreaProps {
  t: SidebarT;
  effectivePath: EffectiveFinderPath;
  currentPath: FinderPath;
  mode: LearningHubSidebarProps['mode'];
  onOpenApp: LearningHubSidebarProps['onOpenApp'];
  activeFileId: LearningHubSidebarProps['activeFileId'];
  highlightedIds: LearningHubSidebarProps['highlightedIds'];
  isCollapsed: boolean;
  isSmallScreen: boolean;
  isMountedRef: React.MutableRefObject<boolean>;
  items: DstuNode[];
  displayedItems: DstuNode[];
  isLoading: boolean;
  error: string | null;
  viewMode: ViewMode;
  selectedIds: Set<string>;
  multiSelectActive: boolean;
  isMultiSelectMode: boolean;
  isSearching: boolean;
  searchMeta: { truncated: boolean; limit: number } | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  debouncedSearchQuery: string;
  currentQuickAccessType: QuickAccessType | null;
  isInMemoryFolder: boolean;
  memoryTreeView: boolean;
  setMemoryTreeView: React.Dispatch<React.SetStateAction<boolean>>;
  notesLearningView: NotesLearningFinderView;
  setNotesLearningView: (view: NotesLearningFinderView) => void;
  examsView: ExamsFinderView;
  setExamsView: (view: ExamsFinderView) => void;
  examsMistakesActive: boolean;
  canCreateInCurrentView: boolean;
  canDragDropInCurrentView: boolean;
  isTrashView: boolean;
  inlineEdit: Pick<InlineEditState, 'editingId'>;
  handleQuickAccessNavigate: (type: QuickAccessType) => Promise<void>;
  handleOpen: OpenHandlers['handleOpen'];
  handleOpenMany: OpenHandlers['handleOpenMany'];
  enterFolder: (folderId: string, folderName?: string, folderPath?: string) => Promise<void>;
  navigateTo: (path: FinderPath) => void;
  goUp: () => void;
  handleRefresh: () => Promise<void>;
  select: (id: string, selectionMode: 'single' | 'toggle' | 'range') => void;
  clearSelection: () => void;
  setSelectedIds: (ids: Set<string>) => void;
  handleContextMenu: (e: React.MouseEvent, item: DstuNode) => void;
  handleContainerContextMenu: (e: React.MouseEvent) => void;
  handleEmptyStateCreate: (e: React.MouseEvent) => void;
  handleMoveItem: (itemId: string, targetFolderId: string | null) => Promise<void>;
  handleMoveItems: (itemIds: string[], targetFolderId: string | null) => Promise<void>;
  handleInlineEditConfirm: (itemId: string, newName: string) => Promise<void>;
  handleInlineEditCancel: (itemId: string) => void;
  startInlineEdit: (id: string, type: 'folder' | 'resource', name: string) => void;
  getItemDisplayName: (item: DstuNode) => string | undefined;
  parentDropTargets: DropTargets['parentDropTargets'];
  specialDropTargets: DropTargets['specialDropTargets'];
  handleSpecialDrop: (targetId: 'favorites' | 'trash', itemIds: string[]) => Promise<void>;
}

/** 主内容区：特殊系统视图（索引状态 / 记忆 / 桌面）或文件列表 */
export function SidebarContentArea({
  t,
  effectivePath,
  currentPath,
  mode,
  onOpenApp,
  activeFileId,
  highlightedIds,
  isCollapsed,
  isSmallScreen,
  isMountedRef,
  items,
  displayedItems,
  isLoading,
  error,
  viewMode,
  selectedIds,
  multiSelectActive,
  isMultiSelectMode,
  isSearching,
  searchMeta,
  searchQuery,
  setSearchQuery,
  debouncedSearchQuery,
  currentQuickAccessType,
  isInMemoryFolder,
  memoryTreeView,
  setMemoryTreeView,
  notesLearningView,
  setNotesLearningView,
  examsView,
  setExamsView,
  examsMistakesActive,
  canCreateInCurrentView,
  canDragDropInCurrentView,
  isTrashView,
  inlineEdit,
  handleQuickAccessNavigate,
  handleOpen,
  handleOpenMany,
  enterFolder,
  navigateTo,
  goUp,
  handleRefresh,
  select,
  clearSelection,
  setSelectedIds,
  handleContextMenu,
  handleContainerContextMenu,
  handleEmptyStateCreate,
  handleMoveItem,
  handleMoveItems,
  handleInlineEditConfirm,
  handleInlineEditCancel,
  startInlineEdit,
  getItemDisplayName,
  parentDropTargets,
  specialDropTargets,
  handleSpecialDrop,
}: SidebarContentAreaProps) {
  return (
    <>
      {effectivePath.viewKind === 'indexStatus' ? (
        <Suspense fallback={
          <div className="flex-1 flex items-center justify-center">
            <CircleNotch className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        }>
          <IndexStatusView />
        </Suspense>
      ) : effectivePath.viewKind === 'memory' ? (
        <Suspense fallback={
          <div className="flex-1 flex items-center justify-center">
            <CircleNotch className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        }>
          <MemoryView onOpenApp={onOpenApp} />
        </Suspense>
      ) : effectivePath.viewKind === 'desktop' ? (
        <DesktopView
          onNavigateQuickAccess={handleQuickAccessNavigate}
          onOpenResource={async (resourceId, resourceType) => {
            // ★ 2026-01-31: 桌面快捷方式打开资源
            // 首先尝试从 items 中查找（如果恰好在当前视图中）
            const item = items.find(i => i.id === resourceId);
            if (item) {
              handleOpen(item);
              return;
            }
            // 使用 dstu.get 获取资源完整信息
            const result = await dstu.get(`/${resourceId}`);
            if (result.ok && result.value) {
              handleOpen(result.value);
            } else {
              showGlobalNotification('error', t('desktop.resourceNotFound'));
            }
          }}
          onOpenFolder={(folderId) => {
            // 打开文件夹 - 通过 enterFolder 处理
            enterFolder(folderId);
          }}
          onCreateInDesktopRoot={async (type: CreateResourceType, desktopRoot: DesktopRootConfig) => {
            // ★ 2026-01-31: 在桌面根目录创建资源并跳转
            const targetFolderId = desktopRoot.folderId || null;
            
            // 1. 先创建资源
            const result = await createEmpty({
              type,
              folderId: targetFolderId,
            });

            if (!isMountedRef.current) return;

            if (result.ok) {
              const resourceNames: Record<CreateResourceType, string> = {
                note: t('finder.create.noteSuccess'),
                exam: t('finder.create.examSuccess'),
                essay: t('finder.create.essaySuccess'),
                translation: t('finder.create.translationSuccess'),
                mindmap: t('finder.create.mindmapSuccess'),
              };
              showGlobalNotification('success', resourceNames[type]);

              // 2. 导航到目标文件夹
              if (targetFolderId) {
                enterFolder(targetFolderId);
              } else {
                // 导航到根目录
                navigateTo({
                  ...currentPath,
                  viewKind: 'folder',
                  folderId: null,
                  breadcrumbs: [],
                  typeFilter: null,
                });
              }

              // 3. 打开资源
              if (onOpenApp) {
                onOpenApp(dstuNodeToResourceListItem(result.value, type));
              }
            } else {
              showGlobalNotification('error', result.error.toUserMessage());
            }
          }}
        />
      ) : (
        <>
        {/* ★ 记忆系统改造：记忆文件夹内显示专属工具栏 */}
        {isInMemoryFolder && mode !== 'canvas' && (
          <MemoryFolderBanner
            onRefresh={handleRefresh}
            isTreeView={memoryTreeView}
            onToggleTreeView={() => setMemoryTreeView(v => !v)}
          />
        )}
        {/* ★ 记忆系统改造：树状图预览模式 */}
        {isInMemoryFolder && memoryTreeView && mode !== 'canvas' ? (
          <MemoryTreePreview
            onNavigateToFolder={(folderId) => {
              setMemoryTreeView(false);
              enterFolder(folderId);
            }}
            className="flex-1"
          />
        ) : (
        <>
        {isSearching && searchMeta?.truncated && (
          <div className="shrink-0 px-3 py-1.5 text-caption text-muted-foreground border-b border-border/40">
            {t('finder.search.truncatedHint', { limit: searchMeta.limit })}
          </div>
        )}
        {currentQuickAccessType === 'notes' && mode !== 'canvas' && (
          <NotesLearningViewTabs value={notesLearningView} onChange={setNotesLearningView} />
        )}
        {currentQuickAccessType === 'exams' && mode !== 'canvas' && (
          <FinderViewTabs<ExamsFinderView>
            views={[
              { key: 'all', icon: ListBullets, label: t('mistakeBook.tabs.all') },
              { key: 'mistakes', icon: XCircle, label: t('mistakeBook.tabs.mistakes') },
            ]}
            value={examsView}
            onChange={setExamsView}
            ariaLabel={t('mistakeBook.tabs.label')}
          />
        )}
        {examsMistakesActive ? (
          <div className="min-h-0 flex-1">
            <Suspense fallback={null}>
              <MistakeBookView search={debouncedSearchQuery} />
            </Suspense>
          </div>
        ) : currentQuickAccessType === 'notes' && mode !== 'canvas' && notesLearningView !== 'list' ? (
          <div className="min-h-0 flex-1">
            <NoteLearningViews notes={displayedItems.filter((item) => item.type === 'note')} view={notesLearningView}
              activeId={activeFileId} onOpen={handleOpen} />
          </div>
        ) : (
        <FinderFileList
          items={displayedItems}
          viewMode={isCollapsed || mode === 'canvas' ? 'list' : viewMode}
          selectedIds={selectedIds}
          onSelect={
            multiSelectActive
              ? (id, selectMode) => {
                  // ★ 多选模式下，普通单击改为 toggle 模式，允许累加/取消选择
                  select(id, selectMode === 'single' ? 'toggle' : selectMode);
                }
              : mode === 'canvas'
                ? (id, _mode) => {
                    // canvas 非多选模式下，单击直接打开文件/文件夹
                    const item = displayedItems.find(i => i.id === id);
                    if (item) handleOpen(item);
                  }
                : select
          }
          onOpen={
            multiSelectActive
              ? (item) => { if (item.type === 'folder') handleOpen(item); }
              : handleOpen
          }
          onOpenMany={mode === 'canvas' ? undefined : handleOpenMany}
          onContextMenu={mode === 'canvas' ? undefined : handleContextMenu}
          multiSelectMode={multiSelectActive}
          onContainerClick={mode === 'canvas' ? (isMultiSelectMode ? clearSelection : undefined) : clearSelection}
          onContainerContextMenu={mode === 'canvas' ? undefined : handleContainerContextMenu}
          onEmptyCreate={mode === 'canvas' ? undefined : handleEmptyStateCreate}
          onMoveItem={mode === 'canvas' ? undefined : handleMoveItem}
          onMoveItems={mode === 'canvas' ? undefined : handleMoveItems}
          isLoading={isLoading}
          error={error}
          canCreate={canCreateInCurrentView}
          emptyMessage={
            effectivePath.viewKind === 'favorites'
              ? t('finder.empty.favorites')
              : effectivePath.viewKind === 'recent'
                ? t('finder.empty.recent')
                : effectivePath.viewKind === 'trash'
                  ? t('finder.empty.trash')
                  : undefined
          }
          emptyHint={
            effectivePath.viewKind === 'trash'
              ? t('finder.empty.trashHint')
              : !canCreateInCurrentView
                ? t(isSmallScreen ? 'finder.empty.noCreateHintTouch' : 'finder.empty.noCreateHint')
                : undefined
          }
          enableDragDrop={mode !== 'canvas' && canDragDropInCurrentView}
          editingId={mode === 'canvas' ? undefined : inlineEdit.editingId}
          onEditConfirm={mode === 'canvas' ? undefined : handleInlineEditConfirm}
          onEditCancel={mode === 'canvas' ? undefined : handleInlineEditCancel}
          compact={isCollapsed || mode === 'canvas'}
          activeFileId={activeFileId}
          enableBoxSelect={mode === 'canvas' ? isMultiSelectMode : !isCollapsed}
          onSelectionChange={setSelectedIds}
          onRetry={handleRefresh}
          highlightedIds={highlightedIds}
          getItemDisplayName={getItemDisplayName}
          onRequestRename={
            mode === 'canvas' || isTrashView
              ? undefined
              : (item) => startInlineEdit(item.id, item.type === 'folder' ? 'folder' : 'resource', item.name)
          }
          parentDropTargets={mode === 'canvas' || !canDragDropInCurrentView ? undefined : parentDropTargets}
          specialDropTargets={mode === 'canvas' || !canDragDropInCurrentView ? undefined : specialDropTargets}
          onSpecialDrop={mode === 'canvas' || !canDragDropInCurrentView ? undefined : handleSpecialDrop}
          onNavigateUp={
            mode === 'canvas' || isTrashView
              ? undefined
              : () => {
                  if (effectivePath.viewKind === 'folder' && (effectivePath.folderId || effectivePath.breadcrumbs.length > 0)) {
                    goUp();
                  }
                }
          }
          searchQuery={searchQuery}
          onClearSearch={() => setSearchQuery('')}
        />
        )}
        </>
        )}
        </>
      )}
    </>
  );
}
