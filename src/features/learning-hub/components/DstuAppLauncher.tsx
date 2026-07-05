import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlass,
  Plus,
  X,
  ArrowClockwise,
  FolderPlus,
  FileText,
  ClipboardText,
  Translate,
  PenNib,
  FlowArrow,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  mobileDrawerNavRowClassName,
  mobileDrawerRowIconWrapClassName,
  mobileDrawerRowTitleClassName,
  mobileDrawerSectionLabelClassName,
} from '@/components/layout/mobileDrawerStyles';
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
} from '../icons';
import {
  getLauncherTypeFromQuickAccessType,
  getQuickAccessTypeFromLauncherType,
  type QuickAccessType,
} from '../learningHubContracts';

interface DstuAppLauncherProps {
  /** 当前选中的应用/类型 */
  activeType?: string;
  /** 选择应用回调 */
  onSelectApp?: (type: string) => void;
  /** 快捷创建并打开资源回调 */
  onCreateAndOpen?: (type: 'exam' | 'essay' | 'translation' | 'note' | 'mindmap') => void;
  /** 新建文件夹回调 */
  onNewFolder?: () => void;
  /** 关闭回调（切换到中间屏幕） */
  onClose?: () => void;
  /** 嵌在 MobileSlidingLayout 统一滚动抽屉内 */
  embedded?: boolean;
  /** 自定义样式 */
  className?: string;
  /** 搜索查询 */
  searchQuery?: string;
  /** 搜索变更回调 */
  onSearchChange?: (query: string) => void;
  /** 当前视图是否禁用搜索 */
  searchDisabled?: boolean;
  /** 当前视图是否禁用新建 */
  createDisabled?: boolean;
  /** 刷新当前视图（文件列表 / 导航状态） */
  onRefresh?: () => void | Promise<void>;
  /** 是否正在刷新 */
  isRefreshing?: boolean;
}

/**
 * DstuAppLauncher 移动端应用启动器
 * 使用 React.memo 优化，避免父组件状态变化时不必要的重渲染
 */
export const DstuAppLauncher: React.FC<DstuAppLauncherProps> = React.memo(({
  activeType = 'all',
  onSelectApp,
  onCreateAndOpen,
  onNewFolder,
  onClose,
  embedded = false,
  className,
  searchQuery = '',
  onSearchChange,
  searchDisabled = false,
  createDisabled = false,
  onRefresh,
  isRefreshing = false,
}) => {
  const { t } = useTranslation(['learningHub', 'common', 'sidebar']);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭新建菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(event.target as Node)) {
        setShowCreateMenu(false);
      }
    };
    if (showCreateMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showCreateMenu]);

  // 规范化 activeType
  const normalizedActiveType = activeType
    ? getQuickAccessTypeFromLauncherType(activeType)
    : null;

  const handleNavigate = (type: QuickAccessType) => {
    const targetType = getLauncherTypeFromQuickAccessType(type);
    onSelectApp?.(targetType);
    onClose?.();
  };

  const handleCreate = (type: 'folder' | 'exam' | 'essay' | 'translation' | 'note' | 'mindmap') => {
    setShowCreateMenu(false);
    if (type === 'folder') {
      onNewFolder?.();
    } else {
      onCreateAndOpen?.(type);
    }
    onClose?.();
  };

  // 菜单项配置（与桌面端 FinderQuickAccess 保持一致）
  const quickAccessItems = [
    { type: 'desktop', CustomIcon: DesktopIcon, label: t('learningHub:finder.quickAccess.desktop') },
    { type: 'allFiles', CustomIcon: AllFilesIcon, label: t('learningHub:apps.allFiles') },
    { type: 'recent', CustomIcon: RecentIcon, label: t('learningHub:apps.recent') },
    { type: 'favorites', CustomIcon: FavoriteIcon, label: t('learningHub:apps.favorites') },
  ];

  const resourceTypeItems = [
    { type: 'notes', CustomIcon: NoteIcon, label: t('learningHub:resourceType.note') },
    { type: 'textbooks', CustomIcon: TextbookIcon, label: t('learningHub:resourceType.textbook') },
    { type: 'exams', CustomIcon: ExamIcon, label: t('learningHub:resourceType.exam') },
    { type: 'essays', CustomIcon: EssayIcon, label: t('learningHub:resourceType.essay') },
    { type: 'translations', CustomIcon: TranslationIcon, label: t('learningHub:resourceType.translation') },
    { type: 'mindmaps', CustomIcon: MindmapIcon, label: t('learningHub:resourceType.mindmap') },
  ];

  const mediaItems = [
    { type: 'images', CustomIcon: ImageFileIcon, label: t('learningHub:resourceType.image') },
    { type: 'files', CustomIcon: GenericFileIcon, label: t('learningHub:resourceType.file') },
  ];

  const systemItems = [
    { type: 'trash', CustomIcon: TrashIcon, label: t('learningHub:apps.trash') },
    { type: 'indexStatus', CustomIcon: IndexStatusIcon, label: t('learningHub:finder.quickAccess.indexStatus') },
    { type: 'memory', CustomIcon: MemoryIcon, label: t('learningHub:memory.title') },
  ];

  const renderEmbeddedNavItem = (item: { type: string; CustomIcon?: React.FC<ResourceIconProps>; label: string }) => {
    const isActive = normalizedActiveType === item.type;
    const Icon = item.CustomIcon;

    return (
      <button
        key={item.type}
        type="button"
        aria-current={isActive ? 'page' : undefined}
        onClick={() => handleNavigate(item.type as QuickAccessType)}
        className={mobileDrawerNavRowClassName(isActive, 'group gap-2.5')}
      >
        <span className={mobileDrawerRowIconWrapClassName}>
          {Icon ? <Icon size={18} /> : null}
        </span>
        <span className={mobileDrawerRowTitleClassName}>{item.label}</span>
      </button>
    );
  };

  const renderLegacyNavItem = (item: { type: string; CustomIcon?: React.FC<ResourceIconProps>; label: string }) => {
    const isActive = normalizedActiveType === item.type;
    const Icon = item.CustomIcon;

    return (
      <NotionButton
        key={item.type}
        variant="ghost"
        size="sm"
        onClick={() => handleNavigate(item.type as QuickAccessType)}
        className={cn(
          'w-full !justify-start gap-3 !px-3 !py-[9px] group',
          isActive
            ? 'bg-accent/80 text-foreground font-medium'
            : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground',
        )}
      >
        {Icon && (
          <Icon
            size={21}
            className={cn(
              'shrink-0 transition-transform duration-200',
              isActive ? 'scale-105' : 'group-hover:scale-105 opacity-80 group-hover:opacity-100',
            )}
          />
        )}
        <span className="text-[16px] truncate flex-1 text-left">
          {item.label}
        </span>
      </NotionButton>
    );
  };

  const renderNavItem = embedded ? renderEmbeddedNavItem : renderLegacyNavItem;

  const renderSectionTitle = (title: string) => {
    if (embedded) {
      return (
        <span key={title} className={mobileDrawerSectionLabelClassName}>
          {title}
        </span>
      );
    }
    return (
      <div key={title} className="px-3 pt-4 pb-1.5">
        <span className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          {title}
        </span>
      </div>
    );
  };

  const toolbar = (
    <div className={cn('flex items-center gap-1.5', embedded ? 'mb-2 px-1' : 'px-3 py-3 shrink-0')}>
      {onRefresh && (
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => void onRefresh()}
          disabled={isRefreshing}
          className="shrink-0"
          title={t('common:refresh', '刷新')}
          aria-label={t('common:refresh', '刷新')}
        >
          <ArrowClockwise size={embedded ? 18 : 20} className={cn(isRefreshing && 'animate-spin')} />
        </NotionButton>
      )}
      <div className="flex-1 relative group min-w-0">
        <MagnifyingGlass
          className={cn(
            'absolute left-2.5 top-1/2 -translate-y-1/2 transition-colors duration-150',
            isSearchFocused ? 'text-primary' : 'text-muted-foreground/50',
          )}
          size={embedded ? 16 : 18}
        />
        <Input
          type="text"
          placeholder={t('learningHub:finder.search.placeholder')}
          value={searchQuery}
          onChange={(e) => onSearchChange?.(e.target.value)}
          onFocus={() => setIsSearchFocused(true)}
          onBlur={() => setIsSearchFocused(false)}
          disabled={searchDisabled}
          className={cn(
            'w-full pl-9 pr-9',
            embedded ? 'h-9 text-sm sidebar-shell-search' : 'h-[41px] text-[16px]',
          )}
        />
        {searchQuery && (
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => onSearchChange?.('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 !h-5 !w-5 !p-0 hover:bg-[var(--interactive-hover)]"
            aria-label="clear"
          >
            <X size={14} className="text-muted-foreground/60" />
          </NotionButton>
        )}
      </div>
      <div className="relative shrink-0" ref={createMenuRef}>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => !createDisabled && setShowCreateMenu(!showCreateMenu)}
          className={cn(
            showCreateMenu ? 'bg-accent text-foreground' : 'text-muted-foreground/70 hover:text-foreground hover:bg-[var(--interactive-hover)]',
          )}
          title={t('learningHub:finder.toolbar.new')}
          aria-label="new"
          disabled={createDisabled}
        >
          <Plus size={embedded ? 18 : 20} />
        </NotionButton>
        {showCreateMenu && (
          <div className="absolute right-0 top-full z-50 mt-1 w-48 animate-in fade-in zoom-in-95 rounded-lg border border-border bg-popover py-1 shadow-lg duration-100">
            <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              {t('learningHub:quickCreate.title')}
            </div>
            <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('folder')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
              <FolderPlus size={16} className="text-blue-500" />
              {t('learningHub:finder.toolbar.newFolder')}
            </NotionButton>
            <div className="mx-2 my-1 h-px bg-border/50" />
            <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('note')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
              <FileText size={16} className="text-emerald-500" />
              {t('learningHub:finder.toolbar.newNote')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('exam')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
              <ClipboardText size={16} className="text-purple-500" />
              {t('learningHub:finder.toolbar.newExam')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('essay')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
              <PenNib size={16} className="text-pink-500" />
              {t('learningHub:finder.toolbar.newEssay')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('translation')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
              <Translate size={16} className="text-indigo-500" />
              {t('learningHub:finder.toolbar.newTranslation')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('mindmap')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
              <FlowArrow size={16} className="text-teal-500" />
              {t('learningHub:finder.toolbar.newMindMap')}
            </NotionButton>
          </div>
        )}
      </div>
    </div>
  );

  const listBody = (
    <>
      {embedded && (
        <span className={mobileDrawerSectionLabelClassName}>
          {t('sidebar:mobile_drawer.section_learning', '学习资源')}
        </span>
      )}
      <nav aria-label={t('learningHub:title', '学习资源')} className="space-y-0.5">
        {quickAccessItems.map(renderNavItem)}
      </nav>
      {renderSectionTitle(t('learningHub:apps.resourceTypes'))}
      <nav className="space-y-0.5">{resourceTypeItems.map(renderNavItem)}</nav>
      {renderSectionTitle(t('learningHub:finder.quickAccess.media'))}
      <nav className="space-y-0.5">{mediaItems.map(renderNavItem)}</nav>
      {renderSectionTitle(t('learningHub:apps.system'))}
      <nav className="space-y-0.5">{systemItems.map(renderNavItem)}</nav>
    </>
  );

  if (embedded) {
    return (
      <div className={cn('min-h-0 space-y-0.5 pb-1 pt-1 text-foreground', className)}>
        {toolbar}
        {listBody}
      </div>
    );
  }

  return (
    <div className={cn('h-full flex flex-col bg-background', className)}>
      {toolbar}
      <CustomScrollArea className="flex-1 min-h-0">
        <div className="px-2 pb-6">
          <div className="mt-1 space-y-1">{quickAccessItems.map(renderLegacyNavItem)}</div>
          {renderSectionTitle(t('learningHub:apps.resourceTypes'))}
          <div className="space-y-1">{resourceTypeItems.map(renderLegacyNavItem)}</div>
          {renderSectionTitle(t('learningHub:finder.quickAccess.media'))}
          <div className="space-y-1">{mediaItems.map(renderLegacyNavItem)}</div>
          {renderSectionTitle(t('learningHub:apps.system'))}
          <div className="space-y-1">{systemItems.map(renderLegacyNavItem)}</div>
        </div>
      </CustomScrollArea>
    </div>
  );
});

export default DstuAppLauncher;
