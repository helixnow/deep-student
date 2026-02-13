import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  Search,
  Plus,
  FolderPlus,
  X,
  FileText,
  BookOpen,
  ClipboardList,
  PenTool,
  Languages,
  Image,
  File,
  Workflow,
} from 'lucide-react';
import {
  NoteIcon,
  TextbookIcon,
  ExamIcon,
  EssayIcon,
  TranslationIcon,
  MindmapIcon,
  ImageFileIcon,
  GenericFileIcon,
  FavoriteIcon,
  RecentIcon,
  TrashIcon,
  IndexStatusIcon,
  MemoryIcon,
  AllFilesIcon,
  DesktopIcon,
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
import type { QuickAccessType } from '../../stores/finderStore';
import { CustomScrollArea } from '@/components/custom-scroll-area';

interface FinderQuickAccessProps {
  collapsed: boolean;
  activeType: QuickAccessType | null;
  onNavigate: (type: QuickAccessType) => void;
  onToggleCollapse?: () => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  onNewFolder?: () => void;
  onNewNote?: () => void;
  onNewExam?: () => void;
  onNewTextbook?: () => void;
  onNewTranslation?: () => void;
  onNewEssay?: () => void;
  onNewMindMap?: () => void;
  favoriteCount?: number;
  noteCount?: number;
  textbookCount?: number;
  examCount?: number;
  essayCount?: number;
  translationCount?: number;
  recentCount?: number;
  trashCount?: number;
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
  onNewFolder,
  onNewNote,
  onNewExam,
  onNewTextbook,
  onNewTranslation,
  onNewEssay,
  onNewMindMap,
  favoriteCount,
  noteCount,
  textbookCount,
  examCount,
  essayCount,
  translationCount,
  recentCount,
  trashCount
}: FinderQuickAccessProps) {
  const { t } = useTranslation('learningHub');
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  const quickAccessItems: { type: QuickAccessType; CustomIcon?: React.FC<ResourceIconProps>; icon?: any; label: string; count?: number; color?: string }[] = [
    { type: 'desktop', CustomIcon: DesktopIcon, label: t('finder.quickAccess.desktop') },
    { type: 'allFiles', CustomIcon: AllFilesIcon, label: t('finder.quickAccess.allFiles') },
    { type: 'recent', CustomIcon: RecentIcon, label: t('finder.quickAccess.recent'), count: recentCount },
    { type: 'favorites', CustomIcon: FavoriteIcon, label: t('finder.quickAccess.favorites'), count: favoriteCount },
  ];

  const resourceTypeItems: { type: QuickAccessType; CustomIcon?: React.FC<ResourceIconProps>; icon?: any; label: string; count?: number; color?: string }[] = [
    { type: 'notes', CustomIcon: NoteIcon, label: t('finder.quickAccess.notes'), count: noteCount },
    { type: 'textbooks', CustomIcon: TextbookIcon, label: t('finder.quickAccess.textbooks'), count: textbookCount },
    { type: 'exams', CustomIcon: ExamIcon, label: t('finder.quickAccess.exams'), count: examCount },
    { type: 'essays', CustomIcon: EssayIcon, label: t('finder.quickAccess.essays'), count: essayCount },
    { type: 'translations', CustomIcon: TranslationIcon, label: t('finder.quickAccess.translations'), count: translationCount },
    { type: 'mindmaps', CustomIcon: MindmapIcon, label: t('finder.quickAccess.mindmaps') },
  ];

  const mediaItems: { type: QuickAccessType; CustomIcon?: React.FC<ResourceIconProps>; icon?: any; label: string; color?: string }[] = [
    { type: 'images', CustomIcon: ImageFileIcon, label: t('finder.quickAccess.images') },
    { type: 'files', CustomIcon: GenericFileIcon, label: t('finder.quickAccess.files') },
  ];

  const systemItems: { type: QuickAccessType; CustomIcon?: React.FC<ResourceIconProps>; icon?: any; label: string; count?: number; color?: string }[] = [
    { type: 'trash', CustomIcon: TrashIcon, label: t('finder.quickAccess.trash'), count: trashCount },
    { type: 'indexStatus', CustomIcon: IndexStatusIcon, label: t('finder.quickAccess.indexStatus') },
    { type: 'memory', CustomIcon: MemoryIcon, label: t('memory.title') },
  ];

  const items = [...quickAccessItems, ...resourceTypeItems, ...mediaItems, ...systemItems];

  const typeFilterToQuickAccess: Record<string, QuickAccessType> = {
    'note': 'notes',
    'textbook': 'textbooks',
    'exam': 'exams',
    'essay': 'essays',
    'translation': 'translations',
    'image': 'images',
    'file': 'files',
    'mindmap': 'mindmaps',
  };
  
  const normalizedActiveType = activeType 
    ? (typeFilterToQuickAccess[activeType] || activeType) 
    : null;

  const renderNavButton = (
    type: QuickAccessType,
    Icon: React.ComponentType<{ className?: string }> | undefined,
    label: string,
    count?: number,
    iconColor?: string,
    CustomIcon?: React.FC<ResourceIconProps>
  ) => {
    const isActive = normalizedActiveType === type;
    const button = (
      <button
        className={cn(
          'group relative w-full flex items-center transition-all duration-150 ease-out rounded-md',
          collapsed ? 'justify-center px-2 py-2.5' : 'gap-2.5 px-2.5 py-2',
          isActive 
            ? 'bg-accent dark:bg-accent/70 text-foreground' 
            : 'text-muted-foreground hover:bg-accent/50 dark:hover:bg-accent/30 hover:text-foreground'
        )}
        onClick={() => onNavigate(type)}
      >
        {CustomIcon ? (
          <CustomIcon
            size={20}
            className={cn(
              'shrink-0 transition-transform duration-150',
              isActive && 'scale-105',
              !isActive && 'group-hover:scale-105'
            )}
          />
        ) : Icon ? (
          <Icon className={cn(
            'h-[18px] w-[18px] shrink-0 transition-transform duration-150',
            iconColor || 'text-muted-foreground',
            isActive && 'scale-105',
            !isActive && 'group-hover:scale-105'
          )} />
        ) : null}
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
      </button>
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

  const renderSectionTitle = (title: string) => {
    if (collapsed) return null;
    return (
      <div className="px-2.5 pt-3 pb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          {title}
        </span>
      </div>
    );
  };

  return (
    <div 
      className={cn(
        'flex flex-col bg-muted/30 border-r border-border transition-all duration-200 ease-out overflow-hidden',
        collapsed ? 'w-14' : 'w-52'
      )}
    >
        <div className={cn(
          'flex items-center gap-1.5 shrink-0 px-2 py-2',
          collapsed ? 'justify-center' : ''
        )}>
          {!collapsed ? (
            <>
              <div className="flex-1 relative group">
                <Search className={cn(
                  "absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors duration-150",
                  isSearchFocused ? "text-primary" : "text-muted-foreground/50"
                )} />
                <Input
                  type="text"
                  placeholder={t('finder.search.placeholder')}
                  value={searchQuery}
                  onChange={(e) => onSearchChange?.(e.target.value)}
                  onFocus={() => setIsSearchFocused(true)}
                  onBlur={() => setIsSearchFocused(false)}
                  className={cn(
                    'h-8 pl-8 pr-8 text-[13px] rounded-lg',
                    'bg-muted/40 border-transparent',
                    'placeholder:text-muted-foreground/40',
                    'focus:bg-background focus:border-border/60 focus:ring-1 focus:ring-primary/20',
                    'transition-all duration-150'
                  )}
                />
                {searchQuery && (
                  <button
                    onClick={() => onSearchChange?.('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-md hover:bg-muted/60 transition-colors"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground/60" />
                  </button>
                )}
              </div>
              <AppMenu>
                <AppMenuTrigger asChild>
                  <NotionButton 
                    variant="ghost" 
                    size="icon" 
                    className={cn(
                      "h-8 w-8 rounded-lg shrink-0",
                      "text-muted-foreground/60 hover:text-foreground hover:bg-accent/60",
                      "transition-all duration-150"
                    )}
                    title={t('finder.toolbar.new')}
                  >
                    <Plus className="h-4 w-4" />
                  </NotionButton>
                </AppMenuTrigger>
                <AppMenuContent align="end" className="min-w-[180px]">
                  {onNewFolder && (
                    <AppMenuItem 
                      icon={<FolderPlus className="h-4 w-4 text-blue-500" />}
                      onClick={onNewFolder}
                    >
                      {t('finder.toolbar.newFolder')}
                    </AppMenuItem>
                  )}
                  {onNewNote && (
                    <AppMenuItem 
                      icon={<FileText className="h-4 w-4 text-emerald-500" />}
                      onClick={onNewNote}
                    >
                      {t('finder.toolbar.newNote')}
                    </AppMenuItem>
                  )}
                  {onNewExam && (
                    <AppMenuItem 
                      icon={<ClipboardList className="h-4 w-4 text-purple-500" />}
                      onClick={onNewExam}
                    >
                      {t('finder.toolbar.newExam')}
                    </AppMenuItem>
                  )}
                  {onNewTextbook && (
                    <AppMenuItem 
                      icon={<BookOpen className="h-4 w-4 text-orange-500" />}
                      onClick={onNewTextbook}
                    >
                      {t('finder.toolbar.newTextbook')}
                    </AppMenuItem>
                  )}
                  {onNewTranslation && (
                    <AppMenuItem 
                      icon={<Languages className="h-4 w-4 text-indigo-500" />}
                      onClick={onNewTranslation}
                    >
                      {t('finder.toolbar.newTranslation')}
                    </AppMenuItem>
                  )}
                  {onNewEssay && (
                    <AppMenuItem 
                      icon={<PenTool className="h-4 w-4 text-pink-500" />}
                      onClick={onNewEssay}
                    >
                      {t('finder.toolbar.newEssay')}
                    </AppMenuItem>
                  )}
                  {onNewMindMap && (
                    <AppMenuItem 
                      icon={<Workflow className="h-4 w-4 text-teal-500" />}
                      onClick={onNewMindMap}
                    >
                      {t('finder.toolbar.newMindMap')}
                    </AppMenuItem>
                  )}
                </AppMenuContent>
              </AppMenu>
            </>
          ) : (
            <AppMenu>
              <AppMenuTrigger asChild>
                <NotionButton 
                  variant="ghost" 
                  size="icon" 
                  className="h-9 w-9 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-accent/60"
                  title={t('finder.toolbar.new')}
                >
                  <Plus className="h-4 w-4" />
                </NotionButton>
              </AppMenuTrigger>
              <AppMenuContent align="start" className="min-w-[180px]">
                {onNewFolder && (
                  <AppMenuItem 
                    icon={<FolderPlus className="h-4 w-4 text-blue-500" />}
                    onClick={onNewFolder}
                  >
                    {t('finder.toolbar.newFolder')}
                  </AppMenuItem>
                )}
                {onNewNote && (
                  <AppMenuItem 
                    icon={<FileText className="h-4 w-4 text-emerald-500" />}
                    onClick={onNewNote}
                  >
                    {t('finder.toolbar.newNote')}
                  </AppMenuItem>
                )}
                {onNewExam && (
                  <AppMenuItem 
                    icon={<ClipboardList className="h-4 w-4 text-purple-500" />}
                    onClick={onNewExam}
                  >
                    {t('finder.toolbar.newExam')}
                  </AppMenuItem>
                )}
                {onNewTextbook && (
                  <AppMenuItem 
                    icon={<BookOpen className="h-4 w-4 text-orange-500" />}
                    onClick={onNewTextbook}
                  >
                    {t('finder.toolbar.newTextbook')}
                  </AppMenuItem>
                )}
                {onNewTranslation && (
                  <AppMenuItem 
                    icon={<Languages className="h-4 w-4 text-indigo-500" />}
                    onClick={onNewTranslation}
                  >
                    {t('finder.toolbar.newTranslation')}
                  </AppMenuItem>
                )}
                {onNewEssay && (
                  <AppMenuItem 
                    icon={<PenTool className="h-4 w-4 text-pink-500" />}
                    onClick={onNewEssay}
                  >
                    {t('finder.toolbar.newEssay')}
                  </AppMenuItem>
                )}
                {onNewMindMap && (
                  <AppMenuItem 
                    icon={<Workflow className="h-4 w-4 text-teal-500" />}
                    onClick={onNewMindMap}
                  >
                    {t('finder.toolbar.newMindMap')}
                    </AppMenuItem>
                  )}
                </AppMenuContent>
            </AppMenu>
          )}
        </div>

        <CustomScrollArea className="flex-1" viewportClassName="px-1.5 pb-2">
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
                {renderNavButton(item.type, item.icon, item.label, undefined, item.color, item.CustomIcon)}
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

        {onToggleCollapse && (
          <div className="shrink-0 h-11 flex items-center px-2 border-t border-border">
            <button
              onClick={onToggleCollapse}
              className={cn(
                'w-full flex items-center justify-center py-1.5 rounded-md',
                'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/40',
                'transition-all duration-150'
              )}
              title={collapsed 
                ? t('finder.quickAccess.expand') 
                : t('finder.quickAccess.collapse')
              }
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
            </button>
          </div>
        )}
      </div>
  );
});