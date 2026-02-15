import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Plus,
  X,
  ChevronRight,
  FolderPlus,
  FileText,
  ClipboardList,
  BookOpen,
  Languages,
  PenTool,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
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

// 类型定义
type QuickAccessType = 
  | 'desktop' | 'allFiles' | 'recent' | 'favorites' 
  | 'notes' | 'textbooks' | 'exams' | 'essays' | 'translations' | 'mindmaps'
  | 'images' | 'files'
  | 'trash' | 'indexStatus' | 'memory';

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
  /** 自定义样式 */
  className?: string;
  /** 搜索查询 */
  searchQuery?: string;
  /** 搜索变更回调 */
  onSearchChange?: (query: string) => void;
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
  className,
  searchQuery = '',
  onSearchChange,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
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
    'all': 'allFiles',
  };

  // 规范化 activeType
  const normalizedActiveType = activeType 
    ? (typeFilterToQuickAccess[activeType] || activeType) 
    : null;

  const handleNavigate = (type: QuickAccessType) => {
    // 将复数类型转换回单数类型传递给父组件（如果是资源类型）
    const quickAccessToTypeFilter: Record<string, string> = {
      'notes': 'note',
      'textbooks': 'textbook',
      'exams': 'exam',
      'essays': 'essay',
      'translations': 'translation',
      'images': 'image',
      'files': 'file',
      'mindmaps': 'mindmap',
      'allFiles': 'all',
    };

    const targetType = quickAccessToTypeFilter[type] || type;
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

  // 渲染列表项
  const renderNavItem = (item: { type: string; CustomIcon?: React.FC<ResourceIconProps>; label: string }) => {
    const isActive = normalizedActiveType === item.type;
    const Icon = item.CustomIcon;

    return (
      <NotionButton
        key={item.type}
        variant="ghost" size="sm"
        onClick={() => handleNavigate(item.type as QuickAccessType)}
        className={cn(
          "w-full !justify-start gap-2.5 !px-3 !py-2 group",
          isActive 
            ? "bg-accent/80 text-foreground font-medium" 
            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        )}
      >
        {Icon && (
          <Icon 
            size={18} 
            className={cn(
              "shrink-0 transition-transform duration-200",
              isActive ? "scale-105" : "group-hover:scale-105 opacity-80 group-hover:opacity-100"
            )} 
          />
        )}
        <span className="text-[14px] truncate flex-1 text-left">
          {item.label}
        </span>
      </NotionButton>
    );
  };

  // 渲染分组标题
  const renderSectionTitle = (title: string) => (
    <div className="px-3 pt-4 pb-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
        {title}
      </span>
    </div>
  );

  return (
    <div className={cn("h-full flex flex-col bg-background", className)}>
      {/* 顶部工具栏：搜索 + 新建 */}
      <div className="px-3 py-3 flex items-center gap-2 shrink-0">
        {/* 搜索框 */}
        <div className="flex-1 relative group">
          <Search className={cn(
            "absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors duration-150",
            isSearchFocused ? "text-primary" : "text-muted-foreground/50"
          )} />
          <input
            type="text"
            placeholder={t('learningHub:finder.search.placeholder')}
            value={searchQuery}
            onChange={(e) => onSearchChange?.(e.target.value)}
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => setIsSearchFocused(false)}
            className={cn(
              "w-full h-9 pl-8 pr-8 text-[14px] rounded-lg outline-none transition-all duration-150",
              "bg-muted/40 placeholder:text-muted-foreground/40",
              "focus:bg-background focus:ring-1 focus:ring-primary/20 focus:shadow-sm"
            )}
          />
          {searchQuery && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => onSearchChange?.('')} className="absolute right-2 top-1/2 -translate-y-1/2 !h-5 !w-5 !p-0 hover:bg-muted/60" aria-label="clear">
              <X className="h-3.5 w-3.5 text-muted-foreground/60" />
            </NotionButton>
          )}
        </div>

        {/* 新建按钮 & 菜单 */}
        <div className="relative" ref={createMenuRef}>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setShowCreateMenu(!showCreateMenu)} className={cn(showCreateMenu ? 'bg-accent text-foreground' : 'text-muted-foreground/70 hover:text-foreground hover:bg-accent/50')} title={t('learningHub:finder.toolbar.new')} aria-label="new">
            <Plus className="h-5 w-5" />
          </NotionButton>

          {/* 自定义下拉菜单 */}
          {showCreateMenu && (
            <div className="absolute right-0 top-full mt-1 w-48 py-1 bg-popover border border-border rounded-lg shadow-lg z-50 animate-in fade-in zoom-in-95 duration-100">
              <div className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
                {t('learningHub:quickCreate.title')}
              </div>
              
              <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('folder')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
                <FolderPlus className="w-4 h-4 text-blue-500" />
                {t('learningHub:finder.toolbar.newFolder')}
              </NotionButton>
              
              <div className="h-px bg-border/50 my-1 mx-2" />
              
              <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('note')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
                <FileText className="w-4 h-4 text-emerald-500" />
                {t('learningHub:finder.toolbar.newNote')}
              </NotionButton>
              
              <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('exam')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
                <ClipboardList className="w-4 h-4 text-purple-500" />
                {t('learningHub:finder.toolbar.newExam')}
              </NotionButton>
              
              <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('essay')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
                <PenTool className="w-4 h-4 text-pink-500" />
                {t('learningHub:finder.toolbar.newEssay')}
              </NotionButton>
              
              <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('translation')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
                <Languages className="w-4 h-4 text-indigo-500" />
                {t('learningHub:finder.toolbar.newTranslation')}
              </NotionButton>

              <NotionButton variant="ghost" size="sm" onClick={() => handleCreate('mindmap')} className="w-full !justify-start !px-3 !py-2 text-foreground/80 hover:text-foreground">
                <Workflow className="w-4 h-4 text-teal-500" />
                {t('learningHub:finder.toolbar.newMindMap')}
              </NotionButton>
            </div>
          )}
        </div>
      </div>

      {/* 列表区域 */}
      <CustomScrollArea className="flex-1 min-h-0">
        <div className="px-2 pb-6">
          {/* 快捷访问 */}
          <div className="space-y-0.5 mt-1">
            {quickAccessItems.map(renderNavItem)}
          </div>

          {/* 资源类型 */}
          {renderSectionTitle(t('learningHub:apps.resourceTypes'))}
          <div className="space-y-0.5">
            {resourceTypeItems.map(renderNavItem)}
          </div>

          {/* 媒体文件 */}
          {renderSectionTitle(t('learningHub:finder.quickAccess.media'))}
          <div className="space-y-0.5">
            {mediaItems.map(renderNavItem)}
          </div>

          {/* 系统 */}
          {renderSectionTitle(t('learningHub:apps.system'))}
          <div className="space-y-0.5">
            {systemItems.map(renderNavItem)}
          </div>
        </div>
      </CustomScrollArea>
    </div>
  );
});

export default DstuAppLauncher;
