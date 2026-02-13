/**
 * LearningHubSidebarV2 - 学习资源侧边栏（仅快捷入口导航）
 * 
 * 侧边栏只显示快捷入口导航，文件列表在主内容区显示
 * 
 * ★ 2026-01-31: 同步桌面端分组结构和自定义 SVG 图标
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
} from '@/components/ui/unified-sidebar';
import { useFinderStore } from './stores/finderStore';
import { useLearningHubNavigationSafe } from './LearningHubNavigationContext';
import type { LearningHubSidebarProps } from './types';
import { usePageMount } from '@/debug-panel/hooks/usePageLifecycle';
import { FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
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
} from './icons';

type QuickAccessType = 'allFiles' | 'notes' | 'textbooks' | 'exams' | 'essays' | 'translations' | 'favorites' | 'recent' | 'trash' | 'images' | 'files' | 'mindmaps' | 'indexStatus' | 'memory' | 'desktop';

interface QuickAccessItem {
  type: QuickAccessType;
  CustomIcon: React.FC<ResourceIconProps>;
  labelKey: string;
  defaultLabel: string;
}

// ★ 快捷访问分组（与桌面端 FinderQuickAccess 保持一致）
const QUICK_ACCESS_ITEMS: QuickAccessItem[] = [
  { type: 'desktop', CustomIcon: DesktopIcon, labelKey: 'finder.quickAccess.desktop', defaultLabel: '桌面' },
  { type: 'allFiles', CustomIcon: AllFilesIcon, labelKey: 'finder.quickAccess.allFiles', defaultLabel: '所有文件' },
  { type: 'recent', CustomIcon: RecentIcon, labelKey: 'finder.quickAccess.recent', defaultLabel: '最近使用' },
  { type: 'favorites', CustomIcon: FavoriteIcon, labelKey: 'finder.quickAccess.favorites', defaultLabel: '收藏' },
];

// ★ 资源类型分组
const RESOURCE_TYPE_ITEMS: QuickAccessItem[] = [
  { type: 'notes', CustomIcon: NoteIcon, labelKey: 'finder.quickAccess.notes', defaultLabel: '笔记' },
  { type: 'textbooks', CustomIcon: TextbookIcon, labelKey: 'finder.quickAccess.textbooks', defaultLabel: '教材' },
  { type: 'exams', CustomIcon: ExamIcon, labelKey: 'finder.quickAccess.exams', defaultLabel: '题库' },
  { type: 'essays', CustomIcon: EssayIcon, labelKey: 'finder.quickAccess.essays', defaultLabel: '作文' },
  { type: 'translations', CustomIcon: TranslationIcon, labelKey: 'finder.quickAccess.translations', defaultLabel: '翻译' },
  { type: 'mindmaps', CustomIcon: MindmapIcon, labelKey: 'finder.quickAccess.mindmaps', defaultLabel: '思维导图' },
];

// ★ 媒体分组
const MEDIA_ITEMS: QuickAccessItem[] = [
  { type: 'images', CustomIcon: ImageFileIcon, labelKey: 'finder.quickAccess.images', defaultLabel: '图片' },
  { type: 'files', CustomIcon: GenericFileIcon, labelKey: 'finder.quickAccess.files', defaultLabel: '文档' },
];

// ★ 系统分组
const SYSTEM_ITEMS: QuickAccessItem[] = [
  { type: 'trash', CustomIcon: TrashIcon, labelKey: 'finder.quickAccess.trash', defaultLabel: '回收站' },
  { type: 'indexStatus', CustomIcon: IndexStatusIcon, labelKey: 'finder.quickAccess.indexStatus', defaultLabel: '索引状态' },
  { type: 'memory', CustomIcon: MemoryIcon, labelKey: 'memory.title', defaultLabel: '记忆' },
];

interface LearningHubSidebarV2ExtendedProps extends LearningHubSidebarProps {
  /** 侧边栏宽度，设置为 'full' 时填满容器 */
  width?: number | 'full';
  /** 关闭回调（用于移动滑动模式） */
  onClose?: () => void;
}

export function LearningHubSidebarV2({
  mode,
  onOpenApp,
  className,
  isCollapsed = false,
  onToggleCollapse,
  width,
  onClose,
}: LearningHubSidebarV2ExtendedProps) {
  const { t } = useTranslation('learningHub');
  
  usePageMount('learning-hub-sidebar', 'LearningHubSidebarV2');

  const {
    currentPath,
    quickAccessNavigate,
  } = useFinderStore(
    useShallow((state) => ({
      currentPath: state.currentPath,
      quickAccessNavigate: state.quickAccessNavigate,
    }))
  );

  // ★ 2025-12-31: 移除组件挂载时的 reset() 调用
  // 原因: finderStore 使用 persist 中间件保存导航状态
  // 每次挂载都 reset 会丢失用户的导航状态

  // ★ 2026-01-15: 完全移除 finderStore → navContext 的同步
  // 原因：setCurrentFolderId 会调用 realPathNavigateTo，触发 useFolderNavigationHistory 的 useEffect
  // 向历史栈添加新条目，形成循环。LearningHubSidebar 已经处理了 navContext → finderStore 的单向同步。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _navContext = useLearningHubNavigationSafe(); // 保留引用但不使用同步逻辑

  const activeQuickAccess = useMemo(() => {
    // ★ 特殊文件夹判断（基于 folderId 或 dstuPath）
    if (currentPath.folderId === 'trash' || currentPath.dstuPath === '/@trash') return 'trash';
    if (currentPath.folderId === 'recent' || currentPath.dstuPath === '/@recent') return 'recent';
    if (currentPath.folderId === 'indexStatus' || currentPath.dstuPath === '/@indexStatus') return 'indexStatus';
    if (currentPath.folderId === 'memory' || currentPath.dstuPath === '/@memory') return 'memory';
    // ★ 2026-01-31: 桌面视图
    if (currentPath.folderId === 'desktop' || currentPath.dstuPath === '/@desktop') return 'desktop';
    // favorites 的 folderId 是 null，需要用 dstuPath 判断
    if (currentPath.dstuPath === '/@favorites') return 'favorites';
    
    // ★ 类型筛选判断
    if (currentPath.typeFilter) {
      // 映射 typeFilter（单数）到 QuickAccessType（复数）
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
      return typeFilterToQuickAccess[currentPath.typeFilter] || 'allFiles';
    }
    
    // ★ 默认：全部文件
    return 'allFiles';
  }, [currentPath.folderId, currentPath.dstuPath, currentPath.typeFilter]);

  const handleQuickAccessClick = (type: QuickAccessType) => {
    // ★ 统一使用 quickAccessNavigate 处理所有类型
    quickAccessNavigate(type);
  };

  // ★ 渲染导航项（使用自定义 SVG 图标）
  const renderNavItem = (item: QuickAccessItem) => {
    const isActive = activeQuickAccess === item.type;
    const CustomIcon = item.CustomIcon;
    
    return (
      <UnifiedSidebarItem
        key={item.type}
        id={item.type}
        isSelected={isActive}
        onClick={() => handleQuickAccessClick(item.type)}
        icon={
          <CustomIcon
            size={20}
            className={cn(
              'shrink-0 transition-transform duration-150',
              isActive && 'scale-105'
            )}
          />
        }
        title={t(item.labelKey, item.defaultLabel)}
      />
    );
  };

  // ★ 渲染分组标题
  const renderSectionTitle = (title: string) => (
    <div className="px-3 pt-3 pb-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
        {title}
      </span>
    </div>
  );

  return (
    <UnifiedSidebar
      className={className}
      width={width}
      onClose={onClose}
      displayMode="panel"
      autoResponsive={false}
    >
      <UnifiedSidebarHeader
        title={t('title')}
        icon={FolderOpen}
        showCollapse
      />
      
      <UnifiedSidebarContent>
        {/* 快捷访问分组 */}
        <div className="space-y-0.5">
          {QUICK_ACCESS_ITEMS.map(renderNavItem)}
        </div>

        {/* 资源类型分组 */}
        {renderSectionTitle(t('finder.quickAccess.resourceTypes'))}
        <div className="space-y-0.5">
          {RESOURCE_TYPE_ITEMS.map(renderNavItem)}
        </div>

        {/* 媒体分组 */}
        {renderSectionTitle(t('finder.quickAccess.media'))}
        <div className="space-y-0.5">
          {MEDIA_ITEMS.map(renderNavItem)}
        </div>

        {/* 系统分组 */}
        {renderSectionTitle(t('finder.quickAccess.system'))}
        <div className="space-y-0.5">
          {SYSTEM_ITEMS.map(renderNavItem)}
        </div>
      </UnifiedSidebarContent>
    </UnifiedSidebar>
  );
}

export default LearningHubSidebarV2;