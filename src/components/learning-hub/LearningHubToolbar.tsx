/**
 * Learning Hub 工具栏组件
 *
 * 文档 20 Prompt 4: 访达侧栏容器
 *
 * 功能：
 * - 搜索框
 * - 视图模式切换（列表/图标）
 * - 数据视图切换（文件夹/资源浏览）
 * - 资源类型过滤（资源浏览视图）
 * - 刷新按钮
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  List,
  Grid,
  Grid3X3,
  Folder,
  Database,
  RefreshCw,
  X,
  Filter,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Upload,
  Loader2,
  ChevronRight,
  Settings,
  MoreHorizontal,
  LayoutGrid,
  Plus,
  FolderPlus,
  Home,
  CheckSquare,
  Trash2,
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import { cn } from '@/lib/utils';
import type {
  LearningHubToolbarProps,
  ResourceType,
  SortField,
  SortOrder,
  BreadcrumbItem,
} from './types';
import { RESOURCE_TYPE_CONFIG } from './types';

/**
 * 工具栏组件
 * 使用 React.memo 优化，避免列表滚动等操作导致不必要的重渲染
 */
export const LearningHubToolbar: React.FC<LearningHubToolbarProps> = React.memo(({
  mode,
  viewMode,
  dataView,
  searchQuery,
  onSearchChange,
  onViewModeChange,
  onDataViewChange,
  resourceTypeFilter = 'all',
  onResourceTypeFilterChange,
  sortField = 'updatedAt',
  sortOrder = 'desc',
  onSortChange,
  onRefresh,
  onClose,
  onImportTextbook,
  isImporting = false,
  isLoading = false,
  className,
  breadcrumbPath = [],
  onNavigateToFolder,
  // 多选模式
  isMultiSelectMode = false,
  onToggleMultiSelect,
  showTrash = false,
  onToggleTrash,
}) => {
  const { t } = useTranslation('learningHub');
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);

  // 搜索输入变化处理
  const handleSearchInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSearchChange(e.target.value);
    },
    [onSearchChange]
  );

  // 清空搜索
  const handleClearSearch = useCallback(() => {
    onSearchChange('');
    setIsSearchExpanded(false);
  }, [onSearchChange]);

  // 视图模式切换
  const handleViewModeToggle = useCallback(() => {
    onViewModeChange(viewMode === 'list' ? 'grid' : 'list');
  }, [viewMode, onViewModeChange]);

  // 资源类型过滤
  const handleResourceTypeSelect = useCallback(
    (type: ResourceType) => {
      onResourceTypeFilterChange?.(type);
    },
    [onResourceTypeFilterChange]
  );

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-3 border-b border-border/40 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 h-[52px]',
        className
      )}
    >
      {/* 标题 / 面包屑导航 */}
      <div className="flex items-center gap-1 font-medium text-sm text-foreground/90 select-none min-w-0 flex-shrink">
        {dataView === 'folder' ? (
          // 文件夹视图 - 显示面包屑导航
          <>
            {/* 根目录按钮 */}
            <NotionButton
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 px-1.5 text-xs',
                breadcrumbPath.length === 0 && 'bg-accent'
              )}
              onClick={() => onNavigateToFolder?.(null)}
              title={t('folder.root')}
            >
              <Home className="w-3.5 h-3.5" />
            </NotionButton>

            {/* 面包屑路径 */}
            {breadcrumbPath.map((folder, index) => (
              <React.Fragment key={folder.id}>
                <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-6 px-1.5 text-xs truncate max-w-[100px]',
                    index === breadcrumbPath.length - 1 && 'bg-accent'
                  )}
                  onClick={() => onNavigateToFolder?.(folder.id)}
                  title={folder.title}
                >
                  {folder.title}
                </NotionButton>
              </React.Fragment>
            ))}
          </>
        ) : (
          // 资源视图 - 显示标题
          t('dataView.resource')
        )}
      </div>

      {/* 弹性间隔 */}
      <div className="flex-1" />

      {/* 右侧：工具组 */}
      <div className="flex items-center gap-2">
        {/* 数据视图切换组（文件夹/资源）- Finder 风格分段控件 */}
        {/* 回收站模式下隐藏文件夹视图切换，只显示资源视图 */}
        {!showTrash && (
          <div className="flex items-center bg-muted/30 p-0.5 rounded-lg border border-border/20">
            <NotionButton
              variant="ghost"
              size="icon"
              className={cn(
                "h-7 w-8 rounded-[6px] transition-all",
                dataView === 'folder' 
                  ? "bg-background shadow-sm text-foreground" 
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
              onClick={() => onDataViewChange('folder')}
              title={t('dataView.folder')}
            >
              <Folder className="h-4 w-4" />
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="icon"
              className={cn(
                "h-7 w-8 rounded-[6px] transition-all",
                dataView === 'resource' 
                  ? "bg-background shadow-sm text-foreground" 
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
              onClick={() => onDataViewChange('resource')}
              title={t('dataView.resource')}
            >
              <Database className="h-4 w-4" />
            </NotionButton>
          </div>
        )}

        {/* 分隔线（非回收站模式时显示） */}
        {!showTrash && <div className="w-px h-5 bg-border/40 mx-1" />}

        {/* 视图切换组（网格/列表）- macOS Segmented Control Style */}
        <div className="flex items-center bg-muted/30 p-0.5 rounded-lg border border-border/20">
          <NotionButton
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-8 rounded-[6px] transition-all",
              viewMode === 'grid' 
                ? "bg-background shadow-sm text-foreground" 
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            )}
            onClick={() => onViewModeChange('grid')}
            title={t('viewMode.grid')}
          >
            <Grid className="h-4 w-4" />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-8 rounded-[6px] transition-all",
              viewMode === 'list' 
                ? "bg-background shadow-sm text-foreground" 
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            )}
            onClick={() => onViewModeChange('list')}
            title={t('viewMode.list')}
          >
            <List className="h-4 w-4" />
          </NotionButton>
        </div>

        {/* 分隔线 */}
        <div className="w-px h-5 bg-border/40 mx-1" />

        {/* 排序菜单 */}
        {dataView === 'resource' && onSortChange && (
          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40"
                title={t('sort.title')}
              >
                <ArrowUpDown className="h-4 w-4" />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" className="w-44 p-1">
              <AppMenuItem
                onClick={() => onSortChange('updatedAt', sortField === 'updatedAt' && sortOrder === 'desc' ? 'asc' : 'desc')}
                className="justify-between"
              >
                <span>{t('sort.byTime')}</span>
                {sortField === 'updatedAt' && (sortOrder === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
              </AppMenuItem>
              <AppMenuItem
                onClick={() => onSortChange('title', sortField === 'title' && sortOrder === 'asc' ? 'desc' : 'asc')}
                className="justify-between"
              >
                <span>{t('sort.byName')}</span>
                {sortField === 'title' && (sortOrder === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
              </AppMenuItem>
              <AppMenuItem
                onClick={() => onSortChange('type', sortField === 'type' && sortOrder === 'asc' ? 'desc' : 'asc')}
                className="justify-between"
              >
                <span>{t('sort.byType')}</span>
                {sortField === 'type' && (sortOrder === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>
        )}

        {/* 资源类型/新建操作 */}
        <AppMenu>
          <AppMenuTrigger asChild>
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40"
              title={t('toolbar.actions')}
            >
              <MoreHorizontal className="h-4 w-4" />
            </NotionButton>
          </AppMenuTrigger>
          <AppMenuContent align="end" className="w-52 p-1">
            {/* 资源类型过滤 (仅资源视图) */}
            {dataView === 'resource' && onResourceTypeFilterChange && (
              <>
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{t('filter.label')}</div>
                {(Object.keys(RESOURCE_TYPE_CONFIG) as ResourceType[]).map((type) => (
                  <AppMenuItem
                    key={type}
                    onClick={() => handleResourceTypeSelect(type)}
                    className="pl-8 relative"
                  >
                    {resourceTypeFilter === type && (
                      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                      </span>
                    )}
                    {t(`resourceType.${type}`)}
                  </AppMenuItem>
                ))}
                <AppMenuSeparator />
              </>
            )}

            {/* 导入/新建 */}
            {onImportTextbook && (
              <AppMenuItem onClick={onImportTextbook} disabled={isImporting}>
                <Upload className="h-4 w-4 mr-2" />
                {t('textbook.import')}
              </AppMenuItem>
            )}
            <AppMenuItem disabled>
              <FolderPlus className="h-4 w-4 mr-2" />
              {t('folder.new')}
            </AppMenuItem>
          </AppMenuContent>
        </AppMenu>

        {/* 多选模式切换 */}
        {onToggleMultiSelect && (
          <NotionButton
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8 rounded-lg',
              isMultiSelectMode
                ? 'bg-primary/20 text-primary hover:bg-primary/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
            )}
            onClick={onToggleMultiSelect}
            title={t('multiSelect.enable')}
          >
            <CheckSquare className="h-4 w-4" />
          </NotionButton>
        )}

        {/* 回收站切换 */}
        {onToggleTrash && (
          <NotionButton
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8 rounded-lg',
              showTrash
                ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
            )}
            onClick={onToggleTrash}
            title={t('trash.title')}
          >
            <Trash2 className="h-4 w-4" />
          </NotionButton>
        )}

        {/* 刷新 */}
        {onRefresh && (
          <NotionButton
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40"
            onClick={onRefresh}
            disabled={isLoading}
            title={t('toolbar.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </NotionButton>
        )}

        {/* 搜索框 (可展开) */}
        <div className={cn(
          "relative transition-all duration-300 ease-in-out ml-2",
          isSearchExpanded || searchQuery ? "w-48 sm:w-64" : "w-8 hover:w-10"
        )}>
          {(!isSearchExpanded && !searchQuery) ? (
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
              onClick={() => setIsSearchExpanded(true)}
            >
              <Search className="h-4 w-4" />
            </NotionButton>
          ) : (
            <div className="relative w-full">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
              <Input
                autoFocus
                type="text"
                placeholder={t('toolbar.search')}
                value={searchQuery}
                onChange={handleSearchInput}
                onBlur={() => !searchQuery && setIsSearchExpanded(false)}
                className={cn(
                  "pl-8 pr-8 h-8 text-xs rounded-md transition-all",
                  "bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background focus:border-primary/30 focus:ring-2 focus:ring-primary/10"
                )}
              />
              {searchQuery && (
                <NotionButton
                  variant="ghost"
                  size="icon"
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6 hover:bg-transparent text-muted-foreground hover:text-foreground"
                  onClick={handleClearSearch}
                >
                  <X className="h-3 w-3" />
                </NotionButton>
              )}
            </div>
          )}
        </div>

        {/* 关闭按钮（仅 Canvas 模式） */}
        {mode === 'canvas' && onClose && (
          <NotionButton
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg ml-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </NotionButton>
        )}
      </div>
    </div>
  );
});

LearningHubToolbar.displayName = 'LearningHubToolbar';

export default LearningHubToolbar;
