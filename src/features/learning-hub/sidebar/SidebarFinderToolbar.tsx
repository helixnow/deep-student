import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  List,
  Plus,
  SortAscending,
  SortDescending,
  SquaresFour,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import {
  useDesktopHeader,
  useHasDesktopHeaderHost,
  type DesktopBreadcrumbItem,
} from '@/components/layout/DesktopHeaderContext';
import { DesktopHeaderSearch } from '@/components/layout/DesktopHeaderSearch';
import { TITLEBAR_ICON_CONTROL_CLASS } from '@/components/layout/desktopTitlebarTokens';
import { FinderToolbar, FinderCreateMenuItems } from '../components/finder';
import type { FinderPath, QuickAccessType, SortBy, SortOrder, ViewMode } from '../stores/finderStore';
import type { LearningHubSidebarProps } from '../types';
import type { SidebarT } from './sidebarConstants';
import type { useMemoryFolderDisplay } from './useMemoryFolderDisplay';

const SORT_OPTIONS: readonly { value: SortBy; labelKey: string }[] = [
  { value: 'name', labelKey: 'finder.sort.name' },
  { value: 'updatedAt', labelKey: 'finder.sort.updatedAt' },
  { value: 'createdAt', labelKey: 'finder.sort.createdAt' },
  { value: 'type', labelKey: 'finder.sort.type' },
  { value: 'size', labelKey: 'finder.sort.size' },
];

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
  toolbarPortalTarget: LearningHubSidebarProps['toolbarPortalTarget'];
  toolbarPortalMode: NonNullable<LearningHubSidebarProps['toolbarPortalMode']>;
}

/**
 * 桌面全屏访达工具栏：
 * - 经典壳（`toolbarPortalMode === 'shell'`）：走统一 `useDesktopHeader('learning-hub', ...)` 面包屑与动作规范；
 * - Workbench 窗口（`toolbarPortalMode === 'window'`）与内嵌态：保持 `FinderToolbar`。
 */
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
  quickAccessPortalTarget,
  handleNewNote,
  setCreatingLearningNote,
  handleImportMarkdownNote,
  handleNewExam,
  handleNewTextbook,
  handleNewTranslation,
  handleNewEssay,
  handleNewMindMap,
  toolbarPortalTarget,
  toolbarPortalMode,
}: SidebarFinderToolbarProps) {
  const { t: tSidebar } = useTranslation('sidebar');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const hasDesktopHeaderHost = useHasDesktopHeaderHost();
  const isClassicShellHeader = toolbarPortalMode === 'shell' && hasDesktopHeaderHost;

  const sectionLabel = currentQuickAccessType
    ? t(`finder.quickAccess.${currentQuickAccessType}`)
    : t('folder.root');

  const rootHubLabel = tSidebar('navigation.learning_hub', { defaultValue: t('title') });

  const shellBreadcrumbs = useMemo<DesktopBreadcrumbItem[]>(() => {
    if (displayBreadcrumbs.length === 0) {
      return [
        { id: 'lh-root', label: rootHubLabel },
        { id: `lh-section-${currentQuickAccessType ?? 'all'}`, label: sectionLabel },
      ];
    }

    return [
      {
        id: 'lh-root',
        label: rootHubLabel,
        onClick: () => jumpToBreadcrumb(-1),
      },
      ...displayBreadcrumbs.map((crumb, index) => {
        const isLast = index === displayBreadcrumbs.length - 1;
        return {
          id: `lh-crumb-${crumb.id}`,
          label: crumb.name,
          onClick: isLast ? undefined : () => jumpToBreadcrumb(index),
        };
      }),
    ];
  }, [currentQuickAccessType, displayBreadcrumbs, jumpToBreadcrumb, rootHubLabel, sectionLabel]);

  const resolvedSearchPlaceholder = !canSearchInCurrentView
    ? t('finder.search.placeholderDisabled')
    : searchPlaceholder || t('finder.search.placeholder');

  const nextViewMode: ViewMode = viewMode === 'grid' ? 'list' : 'grid';
  const nextViewModeLabel = nextViewMode === 'grid'
    ? t('finder.viewMode.grid')
    : t('finder.viewMode.list');

  const createMenuItemsNode = quickAccessPortalTarget && canCreateInCurrentView ? (
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
    />
  ) : undefined;

  const shellActions = (
    <>
      <DesktopHeaderSearch
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={resolvedSearchPlaceholder}
        disabled={!canSearchInCurrentView}
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => setViewMode(nextViewMode)}
            aria-label={nextViewModeLabel}
            className={cn(TITLEBAR_ICON_CONTROL_CLASS, 'text-muted-foreground hover:text-foreground')}
          >
            {viewMode === 'grid' ? <List size={15} /> : <SquaresFour size={15} />}
          </DsButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">{nextViewModeLabel}</TooltipContent>
      </Tooltip>

      <AppMenu open={sortMenuOpen} onOpenChange={setSortMenuOpen}>
        <AppMenuTrigger asChild>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            title={t('finder.sort.title')}
            aria-label={t('finder.sort.title')}
            className={cn(TITLEBAR_ICON_CONTROL_CLASS, 'text-muted-foreground hover:text-foreground')}
          >
            {sortOrder === 'asc' ? <SortAscending size={15} /> : <SortDescending size={15} />}
          </DsButton>
        </AppMenuTrigger>
        <AppMenuContent align="end" width={170}>
          {SORT_OPTIONS.map((option) => (
            <AppMenuItem
              key={option.value}
              onClick={() => setSorting(option.value, sortOrder)}
              icon={sortBy === option.value ? <Check size={14} /> : <span className="w-3.5" />}
            >
              {t(option.labelKey)}
            </AppMenuItem>
          ))}
          <AppMenuSeparator />
          <AppMenuItem
            onClick={() => setSorting(sortBy, 'asc')}
            icon={sortOrder === 'asc' ? <Check size={14} /> : <span className="w-3.5" />}
          >
            {t('finder.sort.asc')}
          </AppMenuItem>
          <AppMenuItem
            onClick={() => setSorting(sortBy, 'desc')}
            icon={sortOrder === 'desc' ? <Check size={14} /> : <span className="w-3.5" />}
          >
            {t('finder.sort.desc')}
          </AppMenuItem>
        </AppMenuContent>
      </AppMenu>

      {createMenuItemsNode ? (
        <AppMenu>
          <AppMenuTrigger asChild>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              title={t('finder.toolbar.new')}
              aria-label={t('finder.toolbar.new')}
              className={cn(TITLEBAR_ICON_CONTROL_CLASS, 'bg-[color:var(--button-tonal-bg)] text-foreground')}
            >
              <Plus size={15} weight="bold" />
            </DsButton>
          </AppMenuTrigger>
          <AppMenuContent align="end" className="min-w-[180px]">
            {createMenuItemsNode}
          </AppMenuContent>
        </AppMenu>
      ) : null}
    </>
  );

  useDesktopHeader(
    'learning-hub',
    {
      breadcrumbs: shellBreadcrumbs,
      actions: shellActions,
    },
    [
      shellBreadcrumbs,
      searchQuery,
      resolvedSearchPlaceholder,
      canSearchInCurrentView,
      viewMode,
      nextViewMode,
      nextViewModeLabel,
      sortMenuOpen,
      sortBy,
      sortOrder,
      canCreateInCurrentView,
      Boolean(quickAccessPortalTarget),
    ],
    isClassicShellHeader,
  );

  if (isClassicShellHeader) {
    return null;
  }

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
      onNewFolder={canCreateInCurrentView && !quickAccessPortalTarget ? handleNewFolder : undefined}
      onImportFiles={canCreateInCurrentView ? handleNewTextbook : undefined}
      createMenuItems={createMenuItemsNode}
      titlebarMode={toolbarPortalTarget ? toolbarPortalMode : false}
    />
  );
  return toolbarPortalTarget ? createPortal(toolbar, toolbarPortalTarget) : toolbar;
}
