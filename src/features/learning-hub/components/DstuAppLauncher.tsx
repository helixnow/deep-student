import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
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
  /** 快捷创建并打开资源回调（保留兼容签名；搜索与新建已统一收拢至全局顶栏） */
  onCreateAndOpen?: (type: 'exam' | 'essay' | 'translation' | 'note' | 'mindmap') => void;
  /** 新建文件夹回调（保留兼容签名） */
  onNewFolder?: () => void;
  /** 关闭回调（切换到中间屏幕） */
  onClose?: () => void;
  /** 嵌在 MobileSlidingLayout 统一滚动抽屉内 */
  embedded?: boolean;
  /** 自定义样式 */
  className?: string;
  /** 搜索查询（保留兼容签名） */
  searchQuery?: string;
  /** 搜索变更回调（保留兼容签名） */
  onSearchChange?: (query: string) => void;
  /** 当前视图是否禁用搜索（保留兼容签名） */
  searchDisabled?: boolean;
  /** 当前视图是否禁用新建（保留兼容签名） */
  createDisabled?: boolean;
}

/**
 * DstuAppLauncher 移动端应用启动器
 * 使用 React.memo 优化，避免父组件状态变化时不必要的重渲染
 */
export const DstuAppLauncher: React.FC<DstuAppLauncherProps> = React.memo(({
  activeType = 'all',
  onSelectApp,
  onClose,
  embedded = false,
  className,
}) => {
  const { t } = useTranslation(['learningHub', 'common', 'sidebar']);

  // 规范化 activeType
  const normalizedActiveType = activeType
    ? getQuickAccessTypeFromLauncherType(activeType)
    : null;

  const handleNavigate = (type: QuickAccessType) => {
    const targetType = getLauncherTypeFromQuickAccessType(type);
    onSelectApp?.(targetType);
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
    { type: 'memory', CustomIcon: MemoryIcon, label: t('learningHub:memory.navTitle') },
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
              'shrink-0 transition-opacity duration-150',
              isActive ? 'opacity-100' : 'opacity-80 group-hover:opacity-100',
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

  const listBody = (
    <>
      {embedded && (
        <span className={mobileDrawerSectionLabelClassName}>
          {t('sidebar:mobile_drawer.section_learning')}
        </span>
      )}
      {renderSectionTitle(t('learningHub:finder.quickAccess.materials'))}
      <nav aria-label={t('learningHub:title')} className="space-y-0.5">
        {quickAccessItems.map(renderNavItem)}
      </nav>
      {renderSectionTitle(t('learningHub:apps.resourceTypes'))}
      <nav className="space-y-0.5">{resourceTypeItems.map(renderNavItem)}</nav>
      {renderSectionTitle(t('learningHub:finder.quickAccess.media'))}
      <nav className="space-y-0.5">{mediaItems.map(renderNavItem)}</nav>
      {renderSectionTitle(t('learningHub:finder.quickAccess.aiKnowledge'))}
      <nav className="space-y-0.5">{systemItems.map(renderNavItem)}</nav>
    </>
  );

  if (embedded) {
    return (
      <div className={cn('min-h-0 space-y-0.5 pb-1 pt-1 text-foreground', className)}>
        {listBody}
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-background', className)}>
      <CustomScrollArea className="flex-1 min-h-0">
        <div className="px-2 pb-6">
          {renderSectionTitle(t('learningHub:finder.quickAccess.materials'))}
          <div className="space-y-1">{quickAccessItems.map(renderLegacyNavItem)}</div>
          {renderSectionTitle(t('learningHub:apps.resourceTypes'))}
          <div className="space-y-1">{resourceTypeItems.map(renderLegacyNavItem)}</div>
          {renderSectionTitle(t('learningHub:finder.quickAccess.media'))}
          <div className="space-y-1">{mediaItems.map(renderLegacyNavItem)}</div>
          {renderSectionTitle(t('learningHub:finder.quickAccess.aiKnowledge'))}
          <div className="space-y-1">{systemItems.map(renderLegacyNavItem)}</div>
        </div>
      </CustomScrollArea>
    </div>
  );
});

export default DstuAppLauncher;
