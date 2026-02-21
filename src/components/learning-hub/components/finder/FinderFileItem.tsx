import React, { useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { format, formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Star, MoreHorizontal, Check } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DstuNode, DstuNodeType } from '@/dstu/types';
import type { ViewMode } from '../../stores/finderStore';
import { InlineEditText } from '../InlineEditText';

export interface FinderFileItemProps {
  item: DstuNode;
  viewMode: ViewMode;
  isSelected: boolean;
  /** ★ 当前在应用面板中打开（高亮显示） */
  isActive?: boolean;
  onSelect: (mode: 'single' | 'toggle' | 'range') => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isDragOverlay?: boolean;
  isDragging?: boolean;
  /** 拖拽悬停在此项上（只对文件夹有效） */
  isDropTarget?: boolean;
  /** 是否正在内联编辑 */
  isEditing?: boolean;
  /** 内联编辑确认回调 */
  onEditConfirm?: (newName: string) => void;
  /** 内联编辑取消回调 */
  onEditCancel?: () => void;
  /** ★ 紧凑模式（隐藏时间和大小列） */
  compact?: boolean;
  /** ★ 高亮标记（如已关联/已选中） */
  isHighlighted?: boolean;
}

interface SortableFinderFileItemProps extends FinderFileItemProps {
  id: string;
  enableDrag?: boolean;
}

/** 类型标签映射 */
const TYPE_LABELS: Partial<Record<DstuNodeType, string>> = {
  note: '笔记',
  textbook: '教材',
  exam: '题目集',
  translation: '翻译',
  essay: '作文',
  image: '图片',
  file: '文件',
  mindmap: '导图',
  retrieval: '检索',
};

/** 自定义 SVG 图标映射 */
const TYPE_CUSTOM_ICONS: Record<DstuNodeType, React.FC<ResourceIconProps>> = {
  folder: FolderIcon,
  note: NoteIcon,
  textbook: TextbookIcon,
  exam: ExamIcon,
  translation: TranslationIcon,
  essay: EssayIcon,
  image: ImageFileIcon,
  file: GenericFileIcon,
  retrieval: GenericFileIcon,
  mindmap: MindmapIcon,
};

/**
 * FinderFileItem - 文件列表项组件
 * 
 * 使用 React.memo 优化，避免父组件重渲染时不必要的子组件重渲染
 * 比较策略：默认浅比较（props 中的回调应由父组件使用 useCallback 稳定化）
 */
export const FinderFileItem = React.memo(function FinderFileItem({
  item,
  viewMode,
  isSelected,
  isActive = false,
  onSelect,
  onOpen,
  onContextMenu,
  isDragOverlay = false,
  isDragging = false,
  isDropTarget = false,
  isEditing = false,
  onEditConfirm,
  onEditCancel,
  compact = false,
  isHighlighted = false,
}: FinderFileItemProps) {
  const CustomIcon = TYPE_CUSTOM_ICONS[item.type] || GenericFileIcon;
  const isFavorite = Boolean(item.metadata?.isFavorite);
  const snippet = item.metadata?.snippet as string | undefined;
  const matchSource = item.metadata?.matchSource as string | undefined;

  const handleClick = useCallback((e: React.MouseEvent) => {
    // 编辑模式下不处理点击事件
    if (isEditing) return;
    
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      onSelect('toggle');
    } else if (e.shiftKey) {
      onSelect('range');
    } else {
      onSelect('single');
    }
  }, [isEditing, onSelect]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    // 编辑模式下不处理双击事件
    if (isEditing) return;
    
    e.stopPropagation();
    onOpen();
  }, [isEditing, onOpen]);

  const handleEditConfirm = useCallback((newName: string) => {
    onEditConfirm?.(newName);
  }, [onEditConfirm]);

  const handleEditCancel = useCallback(() => {
    onEditCancel?.();
  }, [onEditCancel]);

  // 格式化相对时间
  const relativeTime = formatDistanceToNow(item.updatedAt, { 
    addSuffix: true, 
    locale: zhCN 
  });

  const typeLabel = TYPE_LABELS[item.type];
  const childCountLabel = item.type === 'folder' && item.childCount !== undefined
    ? `${item.childCount} 项`
    : undefined;
  const rowTitle = snippet ? `${item.name}\n${matchSource === 'index' ? '[索引] ' : ''}${snippet}` : item.name;

  if (viewMode === 'list') {
    return (
      <div
        className={cn(
          "group relative flex items-center gap-2 px-3 py-1.5 cursor-default select-none rounded-md mx-1 my-0.5",
          "transition-all duration-150 ease-out",
          "hover:bg-accent/60 dark:hover:bg-accent/40",
          isSelected && "bg-primary/10 dark:bg-primary/20 hover:bg-primary/15 dark:hover:bg-primary/25",
          isActive && !isSelected && "bg-accent/40 dark:bg-accent/30",
          isDragging && "opacity-40 scale-[0.98]",
          isDragOverlay && "shadow-notion-lg ring-1 ring-primary/20 bg-background rounded-lg scale-[1.02]",
          isDropTarget && item.type === 'folder' && "ring-2 ring-primary bg-primary/10 scale-[1.01]"
        )}
        title={rowTitle}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={onContextMenu}
      >
        
        {/* 自定义 SVG 图标 */}
        <div className="shrink-0 transition-transform duration-150 group-hover:scale-105">
          <CustomIcon size={24} />
        </div>
        
        {/* 已关联标记 */}
        {isHighlighted && (
          <div className="shrink-0 flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground">
            <Check className="w-2.5 h-2.5" strokeWidth={3} />
          </div>
        )}

        {/* 名称 + 收藏 */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <InlineEditText
            value={item.name}
            isEditing={isEditing}
            onConfirm={handleEditConfirm}
            onCancel={handleEditCancel}
            selectNameOnly={item.type !== 'folder'}
            textClassName="truncate block text-[13px] font-medium text-foreground/90"
            inputClassName="h-6 text-[13px]"
          />
          {isFavorite && (
            <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
          )}
        </div>
        
        {/* 右侧元数据 - 始终可见 */}
        {!compact && (
          <div className="flex items-center gap-2.5 shrink-0">
            {/* 子项数量（文件夹）或文件大小（文件类） */}
            {(childCountLabel || (item.type !== 'folder' && item.size !== undefined)) && (
              <span className="text-[11px] text-muted-foreground/50 tabular-nums w-12 text-right">
                {childCountLabel ?? formatSize(item.size)}
              </span>
            )}
            {/* 类型标签 */}
            {typeLabel && (
              <span className="text-[10px] text-muted-foreground/45 bg-muted/50 px-1.5 py-0 rounded shrink-0">
                {typeLabel}
              </span>
            )}
            {/* 修改时间 */}
            <span className="text-[11px] text-muted-foreground/55 tabular-nums shrink-0">
              {relativeTime}
            </span>
            {/* 更多操作按钮 - 悬停时显示 */}
            <NotionButton variant="ghost" size="icon" iconOnly className="!h-6 !w-6 !p-1 hover:bg-muted/60 opacity-0 group-hover:opacity-100 transition-opacity duration-150" onClick={(e) => { e.stopPropagation(); onContextMenu(e); }} aria-label="more">
              <MoreHorizontal className="h-4 w-4 text-muted-foreground/60" />
            </NotionButton>
          </div>
        )}
      </div>
    );
  }

  // Grid View - Notion 风格的卡片
  return (
    <div
      className={cn(
        // Notion 风格的网格卡片 - 更大、更精致
        "group relative flex flex-col items-center p-3 rounded-xl cursor-default select-none",
        "w-[88px] h-[100px]",
        "transition-all duration-150 ease-out",
        "border border-transparent",
        // 悬停效果
        "hover:bg-accent/50 dark:hover:bg-accent/30 hover:shadow-notion",
        // 选中状态
        isSelected && "bg-primary/10 dark:bg-primary/15 border-primary/30 shadow-notion",
        // 激活状态
        isActive && !isSelected && "bg-accent/40 border-primary/20",
        // 拖拽状态
        isDragging && "opacity-40 scale-95",
        isDragOverlay && "shadow-notion-lg ring-1 ring-primary/30 bg-background scale-105",
        isDropTarget && item.type === 'folder' && "ring-2 ring-primary bg-primary/10 scale-102 border-primary"
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={onContextMenu}
      title={isEditing ? undefined : (snippet ? `${item.name}\n📄 ${snippet}` : item.name)}
    >
      {/* 已关联标记 */}
      {isHighlighted && (
        <div className="absolute top-1 left-1 flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground z-10">
          <Check className="w-2.5 h-2.5" strokeWidth={3} />
        </div>
      )}
      {/* 收藏星标 */}
      {isFavorite && (
        <Star className="absolute top-1.5 right-1.5 h-3 w-3 text-yellow-500 fill-yellow-500" />
      )}
      
      {/* 自定义 SVG 图标 */}
      <div className="mb-2 transition-transform duration-150 group-hover:scale-110">
        <CustomIcon size={48} />
      </div>
      
      {/* 文件名 */}
      <div className="w-full text-center">
        {isEditing ? (
          <InlineEditText
            value={item.name}
            isEditing={isEditing}
            onConfirm={handleEditConfirm}
            onCancel={handleEditCancel}
            selectNameOnly={item.type !== 'folder'}
            className="text-center"
            inputClassName="text-center !text-[11px]"
          />
        ) : (
          <span className="text-[11px] leading-tight font-medium text-foreground/85 line-clamp-2 break-words">
            {item.name}
          </span>
        )}
      </div>
    </div>
  );
});

/**
 * 可排序的 FinderFileItem 包装组件
 * 
 * 使用 React.memo 优化，避免虚拟滚动列表中不必要的重渲染
 */
export const SortableFinderFileItem = React.memo(function SortableFinderFileItem({
  id,
  enableDrag = true,
  ...props
}: SortableFinderFileItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ 
    id,
    disabled: !enableDrag,
  });

  // ★ 2025-12-11: 文件夹作为放置目标，不应用排序动画（防止"躲开"效果）
  // 只有非文件夹项才应用 transform 动画
  const isFolder = props.item.type === 'folder';
  const style = {
    // 文件夹不应用 transform，保持原位作为静态放置目标
    transform: isFolder ? undefined : CSS.Transform.toString(transform),
    transition: isFolder ? undefined : transition,
  };

  // 只有文件夹可以作为拖放目标
  const isDropTarget = isOver && isFolder;

  return (
    <div 
      ref={setNodeRef} 
      style={style} 
      {...attributes} 
      {...listeners}
      data-finder-item
      data-item-id={id}
    >
      <FinderFileItem
        {...props}
        isDragging={isDragging}
        isDropTarget={isDropTarget}
      />
    </div>
  );
});

function formatSize(bytes?: number): string {
    if (bytes === undefined) return '--';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
