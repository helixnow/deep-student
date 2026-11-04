import type React from 'react';
import { createPortal } from 'react-dom';
import { INK_BOARD_CREATE_ENABLED } from '@/features/ink';
import { FinderToolbar, FinderCreateMenuItems } from '../components/finder';
import type { FinderPath, QuickAccessType, SortBy, SortOrder, ViewMode } from '../stores/finderStore';
import type { LearningHubSidebarProps } from '../types';
import type { SidebarT } from './sidebarConstants';
import type { useMemoryFolderDisplay } from './useMemoryFolderDisplay';

export interface SidebarFinderToolbarProps {
  t: SidebarT;
  displayBreadcrumbs: ReturnType<typeof useMemoryFolderDisplay>['displayBreadcrumbs'];
  jumpToBreadcrumb: (index: number) => void;
  currentQuickAccessType: QuickAccessType | null;
  historyIndex: number;
  history: FinderPath[];
  goBack: () => void;
  goForward: () => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  sortBy: SortBy;
  sortOrder: SortOrder;
  setSorting: (sortBy: SortBy, sortOrder?: SortOrder) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchPlaceholder: string;
  canSearchInCurrentView: boolean;
  canCreateInCurrentView: boolean;
  handleNewFolder: () => void;
  handleRefresh: () => Promise<void>;
  quickAccessPortalTarget: LearningHubSidebarProps['quickAccessPortalTarget'];
  handleNewNote: () => Promise<void>;
  setCreatingLearningNote: React.Dispatch<React.SetStateAction<boolean>>;
  handleImportMarkdownNote: (folderId?: string | null) => Promise<void>;
  handleNewExam: () => Promise<void>;
  handleNewTextbook: () => Promise<void>;
  handleNewTranslation: () => Promise<void>;
  handleNewEssay: () => Promise<void>;
  handleNewMindMap: () => Promise<void>;
  handleNewInk: (folderId?: string | null, mode?: 'paged' | 'board') => Promise<void>;
  toolbarPortalTarget: LearningHubSidebarProps['toolbarPortalTarget'];
  toolbarPortalMode: NonNullable<LearningHubSidebarProps['toolbarPortalMode']>;
}

/** 桌面全屏访达工具栏；有 toolbarPortalTarget 时挂到外部标题栏插槽 */
export function SidebarFinderToolbar({
  t,
  displayBreadcrumbs,
  jumpToBreadcrumb,
  currentQuickAccessType,
  historyIndex,
  history,
  goBack,
  goForward,
  viewMode,
  setViewMode,
  sortBy,
  sortOrder,
  setSorting,
  searchQuery,
  setSearchQuery,
  searchPlaceholder,
  canSearchInCurrentView,
  canCreateInCurrentView,
  handleNewFolder,
  handleRefresh,
  quickAccessPortalTarget,
  handleNewNote,
  setCreatingLearningNote,
  handleImportMarkdownNote,
  handleNewExam,
  handleNewTextbook,
  handleNewTranslation,
  handleNewEssay,
  handleNewMindMap,
  handleNewInk,
  toolbarPortalTarget,
  toolbarPortalMode,
}: SidebarFinderToolbarProps) {
  const toolbar = (
    <FinderToolbar
    breadcrumbs={displayBreadcrumbs}
    onBreadcrumbClick={jumpToBreadcrumb}
    currentTitle={
      displayBreadcrumbs[displayBreadcrumbs.length - 1]?.name ||
      (currentQuickAccessType
        ? t(`finder.quickAccess.${currentQuickAccessType}`)
        : t('title'))
    }
    onNavigateHome={() => jumpToBreadcrumb(-1)}
    canGoBack={historyIndex > 0}
    canGoForward={historyIndex < history.length - 1}
    onBack={goBack}
    onForward={goForward}
    viewMode={viewMode}
    onViewModeChange={setViewMode}
    sortBy={sortBy}
    sortOrder={sortOrder}
    onSortChange={setSorting}
    searchQuery={searchQuery}
    onSearchChange={setSearchQuery}
    searchPlaceholder={searchPlaceholder}
    searchDisabled={!canSearchInCurrentView}
    onNewFolder={canCreateInCurrentView ? handleNewFolder : undefined}
    onRefresh={handleRefresh}
    createMenuItems={quickAccessPortalTarget && canCreateInCurrentView ? (
      <FinderCreateMenuItems
        onNewFolder={handleNewFolder}
        onNewNote={handleNewNote}
        onNewLearningNote={() => setCreatingLearningNote(true)}
        onImportMarkdownNote={() => { void handleImportMarkdownNote(); }}
        onNewExam={handleNewExam}
        onNewTextbook={handleNewTextbook}
        onNewTranslation={handleNewTranslation}
        onNewEssay={handleNewEssay}
        onNewMindMap={handleNewMindMap}
        onNewInk={(mode) => { void handleNewInk(undefined, mode); }}
        boardInkEnabled={INK_BOARD_CREATE_ENABLED}
      />
    ) : undefined}
    titlebarMode={toolbarPortalTarget ? toolbarPortalMode : false}
  />
  );
  return toolbarPortalTarget ? createPortal(toolbar, toolbarPortalTarget) : toolbar;
}
