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
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
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

/** 新建菜单项样式：触屏下项高 ≥44px（契约第 3/6 条），桌面保持原尺寸 */
const CREATE_MENU_ITEM_CLASS =
  'w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground [@media(pointer:coarse)]:min-h-[44px]';

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

  // 点击外部 / Escape 关闭新建菜单
  useEffect(() => {
    if (!showCreateMenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(event.target as Node)) {
        setShowCreateMenu(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowCreateMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showCreateMenu]);

  // 📱 Android 返回键：新建菜单打开时先关闭菜单，而不是收起整个抽屉（契约第 4 条）
  useEffect(() => {
    if (!showCreateMenu) return;
    return registerBackHandler(() => {
      setShowCreateMenu(false);
      return true;
    }, BACK_PRIORITY.overlay);
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
      <DsButton
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
      </DsButton>
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
        <span className="text-ui font-semibold uppercase tracking-wider text-muted-foreground/50">
          {title}
        </span>
      </div>
    );
  };

  const toolbar = (
    <div className={cn('flex items-center gap-1.5', embedded ? 'mb-2 px-1' : 'px-3 py-3 shrink-0')}>
      {onRefresh && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => void onRefresh()}
          disabled={isRefreshing}
          className="shrink-0"
          title={t('common:refresh')}
          aria-label={t('common:refresh')}
        >
          <ArrowClockwise size={embedded ? 18 : 20} className={cn(isRefreshing && 'animate-spin')} />
        </DsButton>
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
          type="search"
          // 禁用时给出原因（此前直接 disabled 无解释，用户不知为何不可用）
          placeholder={searchDisabled
            ? t('learningHub:finder.search.placeholderDisabled')
            : t('learningHub:finder.search.placeholder')}
          value={searchQuery}
          onChange={(e) => onSearchChange?.(e.target.value)}
          onFocus={() => setIsSearchFocused(true)}
          onBlur={() => setIsSearchFocused(false)}
          // 📱 操作闭环：搜索结果显示在中间屏文件列表，回车后收起抽屉查看结果
          onKeyDown={(e) => {
            if (e.key === 'Enter' && searchQuery.trim()) {
              onClose?.();
            }
          }}
          disabled={searchDisabled}
          className={cn(
            'w-full pl-9 pr-9',
            // 统一 16px：<16px 的输入框在 iOS 聚焦时会触发页面自动缩放
            embedded ? 'h-9 text-[16px] sidebar-shell-search' : 'h-[41px] text-[16px]',
          )}
        />
        {searchQuery && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => onSearchChange?.('')}
            // 触屏：伪元素扩大命中区到 ~44px，视觉尺寸不变（对齐 TabBar 关闭钮范式）
            className="absolute right-2 top-1/2 -translate-y-1/2 !h-5 !w-5 !p-0 hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3 [@media(pointer:coarse)]:before:content-['']"
            aria-label={t('common:clear')}
          >
            <X size={14} className="text-muted-foreground/60" />
          </DsButton>
        )}
      </div>
      <div className="relative shrink-0" ref={createMenuRef}>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => !createDisabled && setShowCreateMenu(!showCreateMenu)}
          className={cn(
            showCreateMenu ? 'bg-accent text-foreground' : 'text-muted-foreground/70 hover:text-foreground hover:bg-[var(--interactive-hover)]',
          )}
          title={t('learningHub:finder.toolbar.new')}
          aria-label={t('learningHub:finder.toolbar.new')}
          aria-haspopup="menu"
          aria-expanded={showCreateMenu}
          disabled={createDisabled}
        >
          <Plus size={embedded ? 18 : 20} />
        </DsButton>
        {/* z-dropdown：走全局浮层阶梯，替换裸 z-50 */}
        {showCreateMenu && (
          <div role="menu" className="absolute right-0 top-full z-dropdown mt-1 w-48 ui-zoom-fade-in rounded-lg border border-border bg-popover py-1 shadow-lg">
            <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              {t('learningHub:quickCreate.title')}
            </div>
            <DsButton variant="ghost" size="sm" onClick={() => handleCreate('folder')} className={CREATE_MENU_ITEM_CLASS}>
              <FolderPlus size={16} className="text-blue-500" />
              {t('learningHub:finder.toolbar.newFolder')}
            </DsButton>
            <div className="mx-2 my-1 h-px bg-border/50" />
            <DsButton variant="ghost" size="sm" onClick={() => handleCreate('note')} className={CREATE_MENU_ITEM_CLASS}>
              <FileText size={16} className="text-emerald-500" />
              {t('learningHub:finder.toolbar.newNote')}
            </DsButton>
            <DsButton variant="ghost" size="sm" onClick={() => handleCreate('exam')} className={CREATE_MENU_ITEM_CLASS}>
              <ClipboardText size={16} className="text-purple-500" />
              {t('learningHub:finder.toolbar.newExam')}
            </DsButton>
            <DsButton variant="ghost" size="sm" onClick={() => handleCreate('essay')} className={CREATE_MENU_ITEM_CLASS}>
              <PenNib size={16} className="text-pink-500" />
              {t('learningHub:finder.toolbar.newEssay')}
            </DsButton>
            <DsButton variant="ghost" size="sm" onClick={() => handleCreate('translation')} className={CREATE_MENU_ITEM_CLASS}>
              <Translate size={16} className="text-indigo-500" />
              {t('learningHub:finder.toolbar.newTranslation')}
            </DsButton>
            <DsButton variant="ghost" size="sm" onClick={() => handleCreate('mindmap')} className={CREATE_MENU_ITEM_CLASS}>
              <FlowArrow size={16} className="text-teal-500" />
              {t('learningHub:finder.toolbar.newMindMap')}
            </DsButton>
          </div>
        )}
      </div>
    </div>
  );

  const listBody = (
    <>
      {embedded && (
        <span className={mobileDrawerSectionLabelClassName}>
          {t('sidebar:mobile_drawer.section_learning')}
        </span>
      )}
      <nav aria-label={t('learningHub:title')} className="space-y-0.5">
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
