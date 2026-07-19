import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Brain,
  CaretLeft,
  CaretRight,
  ClockCounterClockwise,
  Database,
  Desktop,
  Files,
  MagnifyingGlass,
  Plus,
  Star,
  Trash,
  X,
} from '@phosphor-icons/react';
import {
  NoteIcon,
  TextbookIcon,
  ExamIcon,
  EssayIcon,
  TranslationIcon,
  MindmapIcon,
  FolderIcon,
  ImageFileIcon,
  GenericFileIcon,
  type ResourceIconProps,
} from '../../icons';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import { cn } from '@/lib/utils';
import type { QuickAccessType } from '../../learningHubContracts';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { IndexStatusMiniBar } from './IndexStatusMiniBar';
import {
  WorkbenchSidebarRow,
  WorkbenchSidebarRowLabel,
  WorkbenchSidebarSurface,
} from '@/features/workbench/components/sidebar';

interface FinderQuickAccessProps {
  collapsed: boolean;
  activeType: QuickAccessType | null;
  onNavigate: (type: QuickAccessType) => void;
  onToggleCollapse?: () => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  /** View-honest placeholder (recent/trash/favorites/smart folder) */
  searchPlaceholder?: string;
  searchDisabled?: boolean;
  onNewFolder?: () => void;
  onNewNote?: () => void;
  onImportMarkdownNote?: () => void;
  onNewExam?: () => void;
  onNewTextbook?: () => void;
  onNewTranslation?: () => void;
  onNewEssay?: () => void;
  onNewMindMap?: () => void;
  createDisabled?: boolean;
  favoriteCount?: number;
  noteCount?: number;
  textbookCount?: number;
  examCount?: number;
  essayCount?: number;
  translationCount?: number;
  recentCount?: number;
  trashCount?: number;
  fillContainer?: boolean;
  hideSearch?: boolean;
}

/**
 * FinderQuickAccess 快捷导航组件
 * 使用 React.memo 优化，避免父组件状态变化时不必要的重渲染
 */
export const FinderQuickAccess = React.memo(function FinderQuickAccess({
  collapsed,
  activeType,
  onNavigate,
  onToggleCollapse,
  searchQuery = '',
  onSearchChange,
  searchPlaceholder,
  searchDisabled = false,
  onNewFolder,
  onNewNote,
  onImportMarkdownNote,
  onNewExam,
  onNewTextbook,
  onNewTranslation,
  onNewEssay,
  onNewMindMap,
  createDisabled = false,
  favoriteCount,
  recentCount,
  trashCount,
  fillContainer = false,
  hideSearch = false
}: FinderQuickAccessProps) {
  const { t } = useTranslation(['learningHub', 'common']);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const resolvedSearchPlaceholder = searchPlaceholder || t('finder.search.placeholder');

  const quickAccessItems: { type: QuickAccessType; CustomIcon?: React.FC<ResourceIconProps>; icon?: any; label: string; count?: number; color?: string }[] = [
    { type: 'desktop', icon: Desktop, label: t('finder.quickAccess.desktop') },
    { type: 'allFiles', icon: Files, label: t('finder.quickAccess.allFiles') },
    { type: 'recent', icon: ClockCounterClockwise, label: t('finder.quickAccess.recent'), count: recentCount },
    { type: 'favorites', icon: Star, label: t('finder.quickAccess.favorites'), count: favoriteCount },
  ];

  // 与 DstuAppLauncher 顺序对齐：资源类型 → 媒体 → 系统
  const resourceTypeItems: { type: QuickAccessType; CustomIcon?: React.FC<ResourceIconProps>; icon?: any; label: string; count?: number; color?: string }[] = [
    { type: 'notes', CustomIcon: NoteIcon, label: t('finder.quickAccess.notes') },
    { type: 'textbooks', CustomIcon: TextbookIcon, label: t('finder.quickAccess.textbooks') },
    { type: 'exams', CustomIcon: ExamIcon, label: t('finder.quickAccess.exams') },
    { type: 'essays', CustomIcon: EssayIcon, label: t('finder.quickAccess.essays') },
    { type: 'translations', CustomIcon: TranslationIcon, label: t('finder.quickAccess.translations') },
    { type: 'mindmaps', CustomIcon: MindmapIcon, label: t('finder.quickAccess.mindmaps') },
  ];

  const mediaItems: { type: QuickAccessType; CustomIcon?: React.FC<ResourceIconProps>; icon?: any; label: string; count?: number; color?: string }[] = [
    { type: 'images', CustomIcon: ImageFileIcon, label: t('finder.quickAccess.images') },
    { type: 'files', CustomIcon: GenericFileIcon, label: t('finder.quickAccess.files') },
  ];

  const systemItems: { type: QuickAccessType; CustomIcon?: React.FC<ResourceIconProps>; icon?: any; label: string; count?: number; color?: string }[] = [
    { type: 'trash', icon: Trash, label: t('finder.quickAccess.trash'), count: trashCount },
    { type: 'indexStatus', icon: Database, label: t('finder.quickAccess.indexStatus') },
    { type: 'memory', icon: Brain, label: t('memory.title') },
  ];

  const renderNavButton = (
    type: QuickAccessType,
    Icon: React.ComponentType<{ className?: string }> | undefined,
    label: string,
    count?: number,
    iconColor?: string,
    CustomIcon?: React.FC<ResourceIconProps>
  ) => {
    const isActive = activeType === type;
    const renderedIcon = CustomIcon ? (
      <CustomIcon
        size={fillContainer ? 18 : 20}
        className={cn(
          'shrink-0 transition-transform duration-150',
          isActive && 'scale-105',
          !isActive && 'group-hover:scale-105'
        )}
      />
    ) : Icon ? (
      <Icon className={cn(
        'h-[18px] w-[18px] shrink-0',
        !fillContainer && 'transition-transform duration-150',
        iconColor || 'text-muted-foreground',
        !fillContainer && isActive && 'scale-105',
        !fillContainer && !isActive && 'group-hover:scale-105'
      )} />
    ) : null;

    // 展开态统一走对话标准的 desktop-shell-nav-row 行配方
    // （fillContainer 壳位与窗口内自持宽度两种模式共用同一行样式）
    if (!collapsed) {
      return (
        <WorkbenchSidebarRow
          isActive={isActive}
          aria-current={isActive ? 'page' : undefined}
          className={isActive ? 'cursor-default' : undefined}
          onClick={isActive ? undefined : () => onNavigate(type)}
          leftSlot={renderedIcon}
          rightSlot={count !== undefined && count > 0 ? (
            <span className="text-[11px] tabular-nums text-[color:var(--shell-navigation-muted)]">
              {count}
            </span>
          ) : null}
        >
          <WorkbenchSidebarRowLabel>{label}</WorkbenchSidebarRowLabel>
        </WorkbenchSidebarRow>
      );
    }

    const button = (
      <NotionButton variant="ghost" size="sm"
        className={cn(
          'group relative w-full !rounded-md',
          collapsed ? 'justify-center !px-2 !py-2.5' : '!justify-start gap-2.5 !px-2.5 !py-2',
          isActive 
            ? 'bg-accent dark:bg-accent/70 text-foreground' 
            : 'text-muted-foreground hover:bg-[var(--interactive-hover)] dark:hover:bg-[var(--interactive-hover)] hover:text-foreground'
        )}
        onClick={() => onNavigate(type)}
      >
        {renderedIcon}
        {!collapsed && (
          <>
            <span className={cn(
              "flex-1 text-left truncate text-[13px]",
              isActive ? "font-medium" : "font-normal"
            )}>
              {label}
            </span>
            {count !== undefined && count > 0 && (
              <span className={cn(
                "text-[11px] tabular-nums px-1.5 py-0.5 rounded-full",
                isActive 
                  ? "bg-primary/15 text-primary" 
                  : "text-muted-foreground/60"
              )}>
                {count}
              </span>
            )}
          </>
        )}
      </NotionButton>
    );

    if (collapsed) {
      return (
        <CommonTooltip 
          key={type} 
          content={<p>{label}{count !== undefined && count > 0 ? ` (${count})` : ''}</p>} 
          position="right" 
          offset={8}
        >
          {button}
        </CommonTooltip>
      );
    }

    return button;
  };

  // 新建菜单项（展开/收起两种布局共用）
  const createMenuItems = (
    <>
      {onNewFolder && (
        <AppMenuItem icon={<FolderIcon size={16} />} onClick={onNewFolder}>
          {t('finder.toolbar.newFolder')}
        </AppMenuItem>
      )}
      {onNewNote && (
        <AppMenuItem icon={<NoteIcon size={16} />} onClick={onNewNote}>
          {t('finder.toolbar.newNote')}
        </AppMenuItem>
      )}
      {onImportMarkdownNote && (
        <AppMenuItem icon={<NoteIcon size={16} />} onClick={onImportMarkdownNote}>
          {t('finder.toolbar.importMarkdown')}
        </AppMenuItem>
      )}
      {onNewExam && (
        <AppMenuItem icon={<ExamIcon size={16} />} onClick={onNewExam}>
          {t('finder.toolbar.newExam')}
        </AppMenuItem>
      )}
      {onNewTextbook && (
        <AppMenuItem icon={<TextbookIcon size={16} />} onClick={onNewTextbook}>
          {t('finder.toolbar.newTextbook')}
        </AppMenuItem>
      )}
      {onNewTranslation && (
        <AppMenuItem icon={<TranslationIcon size={16} />} onClick={onNewTranslation}>
          {t('finder.toolbar.newTranslation')}
        </AppMenuItem>
      )}
      {onNewEssay && (
        <AppMenuItem icon={<EssayIcon size={16} />} onClick={onNewEssay}>
          {t('finder.toolbar.newEssay')}
        </AppMenuItem>
      )}
      {onNewMindMap && (
        <AppMenuItem icon={<MindmapIcon size={16} />} onClick={onNewMindMap}>
          {t('finder.toolbar.newMindMap')}
        </AppMenuItem>
      )}
    </>
  );

  const renderSectionTitle = (title: string) => {
    if (collapsed) return null;
    if (fillContainer) {
      return (
        <div className="px-2 py-1">
          <span className="desktop-shell-nav-section-label min-w-0 truncate">
            {title}
          </span>
        </div>
      );
    }
    return (
      <div className="px-2.5 pt-3 pb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          {title}
        </span>
      </div>
    );
  };

  return (
    <WorkbenchSidebarSurface
      ariaLabel={t('learningHub:title')}
      className={cn(
        'flex flex-col overflow-hidden transition-all duration-200 ease-out',
        fillContainer && 'font-sidebar-study-ui h-full min-w-0',
        /* 对话标准：透明面 + 右缘软分隔线（seam token 见 workbench.tokens.css） */
        fillContainer
          ? 'bg-transparent text-[color:var(--shell-navigation-foreground)]'
          : 'bg-transparent border-r border-[color:var(--wb-sidebar-seam,hsl(var(--border)/0.55))]',
        fillContainer ? 'w-full' : collapsed ? 'w-14' : 'w-[var(--wb-sidebar-width,272px)]'
      )}
    >
        {!hideSearch && <div className={cn(
          'shrink-0 px-2',
          fillContainer ? 'pb-1' : 'flex items-center gap-1.5 py-2',
          collapsed ? 'justify-center' : ''
        )}>
          {!collapsed ? (
            <>
              <div className="flex-1 relative group">
                <MagnifyingGlass className={cn(
                  "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 transition-colors duration-150",
                  isSearchFocused ? "text-[color:var(--sidebar-muted,var(--muted-foreground))]" : "text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-60"
                )} size={14} />
                {fillContainer ? (
                  <input
                    type="search"
                    placeholder={resolvedSearchPlaceholder}
                    aria-label={resolvedSearchPlaceholder}
                    value={searchQuery}
                    onChange={(e) => onSearchChange?.(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && searchQuery) {
                        e.stopPropagation();
                        onSearchChange?.('');
                      }
                    }}
                    onFocus={() => setIsSearchFocused(true)}
                    onBlur={() => setIsSearchFocused(false)}
                    disabled={searchDisabled}
                    className={cn(
                      'h-8 w-full appearance-none rounded-lg border border-transparent bg-[color:var(--interactive-hover)]/60',
                      'pl-8 pr-8 text-[13px] text-[color:var(--sidebar-foreground)] placeholder:text-[color:var(--sidebar-muted,var(--muted-foreground))] placeholder:opacity-70',
                      'outline-none transition-colors focus:border-[color:var(--border)] focus:bg-background',
                      '[&::-webkit-search-cancel-button]:hidden'
                    )}
                  />
                ) : (
                  <Input
                    type="search"
                    placeholder={resolvedSearchPlaceholder}
                    aria-label={resolvedSearchPlaceholder}
                    value={searchQuery}
                    onChange={(e) => onSearchChange?.(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && searchQuery) {
                        e.stopPropagation();
                        onSearchChange?.('');
                      }
                    }}
                    onFocus={() => setIsSearchFocused(true)}
                    onBlur={() => setIsSearchFocused(false)}
                    disabled={searchDisabled}
                    className="h-8 rounded-lg border-transparent bg-muted/40 pl-8 pr-8 text-[13px] placeholder:text-muted-foreground/40 focus:border-border/60 focus:bg-background focus:ring-1 focus:ring-primary/20"
                  />
                )}
                {searchQuery && (
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={() => onSearchChange?.('')} className="absolute right-2 top-1/2 -translate-y-1/2 !h-5 !w-5 !p-0.5 hover:bg-[var(--interactive-hover)]" aria-label={t('common:clear')}>
                    <X size={14} className="text-muted-foreground/60" />
                  </NotionButton>
                )}
              </div>
              {!fillContainer && <AppMenu>
                <AppMenuTrigger asChild>
                  <NotionButton 
                    variant="ghost" 
                    size="icon" 
                    className={cn(
                      "h-8 w-8 rounded-lg shrink-0",
                      "text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)]",
                      "transition-all duration-150"
                    )}
                    title={t('finder.toolbar.new')}
                    disabled={createDisabled}
                  >
                    <Plus size={16} />
                  </NotionButton>
                </AppMenuTrigger>
                <AppMenuContent align="end" className="min-w-[180px]">
                  {createMenuItems}
                </AppMenuContent>
              </AppMenu>}
            </>
          ) : (
            <AppMenu>
              <AppMenuTrigger asChild>
                <NotionButton 
                  variant="ghost" 
                  size="icon" 
                  className="h-9 w-9 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)]"
                  title={t('finder.toolbar.new')}
                  disabled={createDisabled}
                >
                  <Plus className="h-4 w-4" />
                </NotionButton>
              </AppMenuTrigger>
              <AppMenuContent align="start" className="min-w-[180px]">
                {createMenuItems}
              </AppMenuContent>
            </AppMenu>
          )}
        </div>}

        <CustomScrollArea className="flex-1" viewportClassName={fillContainer ? 'px-2 py-1' : 'px-1.5 pb-2'}>
          <div className="space-y-0.5">
            {quickAccessItems.map((item) => (
              <React.Fragment key={item.type}>
                {renderNavButton(item.type, item.icon, item.label, item.count, item.color, item.CustomIcon)}
              </React.Fragment>
            ))}
          </div>

          {renderSectionTitle(t('finder.quickAccess.resourceTypes'))}
          <div className="space-y-0.5">
            {resourceTypeItems.map((item) => (
              <React.Fragment key={item.type}>
                {renderNavButton(item.type, item.icon, item.label, item.count, item.color, item.CustomIcon)}
              </React.Fragment>
            ))}
          </div>

          {renderSectionTitle(t('finder.quickAccess.media'))}
          <div className="space-y-0.5">
            {mediaItems.map((item) => (
              <React.Fragment key={item.type}>
                {renderNavButton(item.type, item.icon, item.label, item.count, item.color, item.CustomIcon)}
              </React.Fragment>
            ))}
          </div>

          {renderSectionTitle(t('finder.quickAccess.system'))}
          <div className="space-y-0.5">
            {systemItems.map((item) => (
              <React.Fragment key={item.type}>
                {renderNavButton(item.type, item.icon, item.label, item.count, item.color, item.CustomIcon)}
              </React.Fragment>
            ))}
          </div>
        </CustomScrollArea>

        {/* 索引状态常驻小条：索引中/待索引/失败时可见，点击直达索引状态页 */}
        <IndexStatusMiniBar
          collapsed={collapsed && !fillContainer}
          onOpenIndexStatus={() => onNavigate('indexStatus')}
        />

        {onToggleCollapse && (
          <div className="shrink-0 h-11 flex items-center px-2 border-t border-border/40">
            <NotionButton variant="ghost" size="sm" onClick={onToggleCollapse} className="w-full justify-center !py-1.5 text-muted-foreground/50 hover:text-muted-foreground hover:bg-[var(--interactive-hover)]" title={collapsed ? t('finder.quickAccess.expand') : t('finder.quickAccess.collapse')}>
              {collapsed ? (
                <CaretRight size={16} />
              ) : (
                <CaretLeft size={16} />
              )}
            </NotionButton>
          </div>
        )}
      </WorkbenchSidebarSurface>
  );
});
