import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS } from 'date-fns/locale';
import { Star, DotsThree, Check } from '@phosphor-icons/react';
import {
  IllustratedNoteIcon,
  IllustratedTextbookIcon,
  IllustratedExamIcon,
  IllustratedEssayIcon,
  IllustratedTranslationIcon,
  IllustratedMindmapIcon,
  IllustratedFolderIcon,
  IllustratedImageIcon,
  IllustratedGenericFileIcon,
  type ResourceIconProps,
} from '../../icons';
import { cn } from '@/lib/utils';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { DstuNode, DstuNodeType } from '@/dstu/types';
import type { ViewMode } from '../../stores/finderStore';
import { InlineEditText } from '../InlineEditText';
import { useMediaQuery } from '@/hooks/useMediaQuery';

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
  /** spring-load 预备高亮（悬停文件夹倒计时中） */
  isSpringLoading?: boolean;
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
  /** ★ 多选模式：触屏单击只切换选中，不再同时触发打开（避免文件夹 toggle+导航双触发） */
  multiSelectMode?: boolean;
}

interface SortableFinderFileItemProps extends FinderFileItemProps {
  id: string;
  enableDrag?: boolean;
}

/** 有类型标签的资源类型（folder 不显示标签）；文案走 i18n indexStatus.resourceType.* */
const LABELED_TYPES: ReadonlySet<DstuNodeType> = new Set([
  'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap', 'retrieval',
] as DstuNodeType[]);

// ★ 记忆系统改造：从笔记 tags 中提取记忆元数据（文案走 i18n finder.memoryMeta.*）
const MEMORY_TYPE_STYLES: Record<string, string> = {
  fact: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  study: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  note: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
};
const MEMORY_PURPOSE_STYLES: Record<string, string> = {
  internalized: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  supplementary: 'bg-slate-500/10 text-slate-500',
  systemic: 'bg-rose-500/10 text-rose-500',
};

function extractMemoryMeta(tags: string[] | undefined) {
  if (!tags || tags.length === 0) return null;
  const typeTag = tags.find(t => t.startsWith('_type:'));
  if (!typeTag) return null; // 不是记忆笔记
  const memoryType = typeTag.slice(6);
  const purposeTag = tags.find(t => t.startsWith('_purpose:'));
  const memoryPurpose = purposeTag ? purposeTag.slice(9) : 'memorized';
  const isImportant = tags.includes('_important');
  return { memoryType, memoryPurpose, isImportant };
}

/** 自定义 SVG 图标映射 */
const TYPE_CUSTOM_ICONS: Record<DstuNodeType, React.FC<ResourceIconProps>> = {
  folder: IllustratedFolderIcon,
  note: IllustratedNoteIcon,
  textbook: IllustratedTextbookIcon,
  exam: IllustratedExamIcon,
  translation: IllustratedTranslationIcon,
  essay: IllustratedEssayIcon,
  image: IllustratedImageIcon,
  file: IllustratedGenericFileIcon,
  retrieval: IllustratedGenericFileIcon,
  mindmap: IllustratedMindmapIcon,
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
  isSpringLoading = false,
  isEditing = false,
  onEditConfirm,
  onEditCancel,
  compact = false,
  isHighlighted = false,
  multiSelectMode = false,
}: FinderFileItemProps) {
  const { t, i18n } = useTranslation(['learningHub', 'common']);
  const CustomIcon = TYPE_CUSTOM_ICONS[item.type] || IllustratedGenericFileIcon;
  const isFavorite = Boolean(item.metadata?.isFavorite);
  const snippet = item.metadata?.snippet as string | undefined;
  const matchSource = item.metadata?.matchSource as string | undefined;
  // ★ 记忆系统改造：提取记忆元数据
  const memoryMeta = item.type === 'note' ? extractMemoryMeta(item.metadata?.tags as string[] | undefined) : null;
  // N-3/N-4: 触屏设备上没有 hover 和双击心智，单击直接打开、更多按钮常显
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

  const handleClick = useCallback((e: React.MouseEvent) => {
    // 编辑模式下不处理点击事件
    if (isEditing) return;
    
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      onSelect('toggle');
    } else if (e.shiftKey) {
      onSelect('range');
    } else if (isTouchPrimary) {
      if (multiSelectMode) {
        // 多选模式：触屏单击只切换选中，不触发打开（否则文件夹会 toggle+导航双触发）
        onSelect('toggle');
      } else {
        // 移动端范式：单击 = 打开（文件夹进入 / 文件打开），选中态同步更新
        onSelect('single');
        onOpen();
      }
    } else {
      onSelect('single');
    }
  }, [isEditing, isTouchPrimary, multiSelectMode, onSelect, onOpen]);

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

  // 格式化相对时间（locale 跟随界面语言）
  const relativeTime = useMemo(() => formatDistanceToNow(item.updatedAt, { 
    addSuffix: true, 
    locale: i18n.language?.startsWith('zh') ? zhCN : enUS 
  }), [item.updatedAt, i18n.language]);

  const typeLabel = LABELED_TYPES.has(item.type)
    ? t(`learningHub:indexStatus.resourceType.${item.type}`)
    : undefined;
  const childCountLabel = item.type === 'folder' && item.childCount !== undefined
    ? t('learningHub:finder.childCount', { count: item.childCount })
    : undefined;
  const rowTitle = snippet
    ? `${item.name}\n${matchSource === 'index' ? `${t('learningHub:finder.matchFromIndex')} ` : ''}${snippet}`
    : item.name;

  if (viewMode === 'list') {
    return (
      <div
        className={cn(
          // 触屏行高 48px（LIST_ITEM_HEIGHT_TOUCH），与虚拟滚动行槽 / 框选命中几何同源
          "group relative flex min-h-10 items-center gap-2 px-3 py-1.5 cursor-default select-none",
          "[@media(pointer:coarse)]:min-h-12",
          "transition-[background-color,opacity] duration-100 ease-out",
          // 触屏按压即时反馈（无 hover 心智，点按瞬间需要可见响应）
          !isSelected && "hover:bg-[var(--interactive-hover)]/70 [@media(pointer:coarse)]:active:bg-[var(--interactive-hover)]",
          isSelected && "bg-primary text-primary-foreground",
          isActive && !isSelected && "bg-[var(--interactive-selected)]",
          isDragging && "opacity-40",
          isDragOverlay && "bg-primary text-primary-foreground shadow-lg",
          isDropTarget && item.type === 'folder' && "outline outline-2 outline-primary outline-offset-[-2px] bg-primary/10",
          isSpringLoading && item.type === 'folder' && !isDropTarget && "outline outline-2 outline-primary/50 outline-offset-[-2px] bg-primary/5 animate-pulse"
        )}
        title={rowTitle}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={onContextMenu}
      >
        
        {/* 自定义 SVG 图标 */}
        <div className="shrink-0">
          <CustomIcon size={24} />
        </div>
        
        {/* 已关联标记 */}
        {isHighlighted && (
          <div className="shrink-0 flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground">
            <Check size={10} strokeWidth={3} />
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
            textClassName={cn(
              'truncate block text-ui font-normal',
              isSelected ? 'text-primary-foreground' : 'text-foreground/90'
            )}
            inputClassName="h-6 text-ui"
          />
          {isFavorite && (
            <Star size={12} className="text-yellow-500 shrink-0" />
          )}
          {/* ★ 记忆 badge */}
          {memoryMeta && (
            <>
              <span className={cn('px-1 py-0 rounded text-2xs font-medium shrink-0', MEMORY_TYPE_STYLES[memoryMeta.memoryType] || 'bg-muted')}>
                {t(`learningHub:finder.memoryMeta.type.${memoryMeta.memoryType}`, memoryMeta.memoryType)}
              </span>
              {memoryMeta.memoryPurpose !== 'memorized' && MEMORY_PURPOSE_STYLES[memoryMeta.memoryPurpose] && (
                <span className={cn('px-1 py-0 rounded text-2xs shrink-0', MEMORY_PURPOSE_STYLES[memoryMeta.memoryPurpose] || 'bg-muted')}>
                  {t(`learningHub:finder.memoryMeta.purpose.${memoryMeta.memoryPurpose}`, memoryMeta.memoryPurpose)}
                </span>
              )}
              {memoryMeta.isImportant && (
                <Star size={10} className="text-amber-500 shrink-0" />
              )}
            </>
          )}
        </div>
        
        {/* 右侧元数据 - 始终可见 */}
        {(!compact || isTouchPrimary) && (
          <div className="flex items-center gap-2.5 shrink-0">
            {!compact && (
              <>
                {/* 子项数量（文件夹）或文件大小（文件类） */}
                {(childCountLabel || (item.type !== 'folder' && item.size !== undefined)) && (
                  <span className={cn('text-[11px] tabular-nums w-12 text-right', isSelected ? 'text-primary-foreground/75' : 'text-muted-foreground/50')}>
                    {childCountLabel ?? formatSize(item.size)}
                  </span>
                )}
                {/* 类型标签 */}
                {typeLabel && (
                  <span className={cn('text-2xs shrink-0', isSelected ? 'text-primary-foreground/75' : 'text-muted-foreground/50')}>
                    {typeLabel}
                  </span>
                )}
                {/* 修改时间 */}
                <span className={cn('text-[11px] tabular-nums shrink-0', isSelected ? 'text-primary-foreground/75' : 'text-muted-foreground/55')}>
                  {relativeTime}
                </span>
              </>
            )}
            {/* 更多操作按钮 - 桌面悬停显示，触屏常显（N-4） */}
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className={cn(
                'hover:bg-[var(--interactive-hover)] transition-opacity duration-150',
                isTouchPrimary
                  ? '!h-11 !w-11 !p-2.5 opacity-100'
                  : '!h-6 !w-6 !p-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
              )}
              onClick={(e) => { e.stopPropagation(); onContextMenu(e); }}
              aria-label={t('common:more')}
            >
              <DotsThree size={isTouchPrimary ? 20 : 16} className={isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground/60'} />
            </DsButton>
          </div>
        )}
      </div>
    );
  }

  // Grid View - Finder-style icon layout
  return (
    <div
      className={cn(
        "group relative flex flex-col items-center p-2 cursor-default select-none",
        "box-border w-[88px] max-w-[88px] h-[100px] shrink-0",
        // ui-press-coarse：触屏按压缩放反馈（仅 pointer:coarse 生效，桌面不变）
        "ui-press-coarse transition-opacity duration-100 ease-out",
        isDragging && "opacity-40",
        isDragOverlay && "drop-shadow-lg",
        isDropTarget && item.type === 'folder' && "rounded-lg bg-primary/10 outline outline-2 outline-primary",
        isSpringLoading && item.type === 'folder' && !isDropTarget && "rounded-lg bg-primary/5 outline outline-2 outline-primary/50 animate-pulse"
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={onContextMenu}
      title={isEditing ? undefined : rowTitle}
    >
      {/* 已关联标记 */}
      {isHighlighted && (
        <div className="absolute top-1 left-1 flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground z-10">
          <Check size={10} strokeWidth={3} />
        </div>
      )}
      {/* 收藏星标 */}
      {isFavorite && (
        <Star size={12} className={cn('absolute top-1.5 text-yellow-500 fill-yellow-500', isTouchPrimary ? 'left-1.5' : 'right-1.5')} />
      )}
      {/* 触屏更多操作入口（N-4）：网格模式无 hover/双指，常显右上角 */}
      {isTouchPrimary && !isEditing && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="absolute right-0 top-0 z-10 !h-11 !w-11 !p-2.5 hover:bg-[var(--interactive-hover)]"
          onClick={(e) => { e.stopPropagation(); onContextMenu(e); }}
          aria-label={t('common:more')}
        >
          <DotsThree size={18} className="text-muted-foreground/70" />
        </DsButton>
      )}
      
      {/* 自定义 SVG 图标：固定盒，防止被网格单元横向拉伸 */}
      <div className={cn(
        'mb-1.5 flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg',
        isActive && !isSelected && 'bg-[var(--interactive-selected)]'
      )}>
        <CustomIcon size={48} className="h-12 w-12 max-w-full shrink-0" />
      </div>
      
      {/* 文件名 */}
      <div className="w-full min-w-0 text-center">
        {isEditing ? (
          <InlineEditText
            value={item.name}
            isEditing={isEditing}
            onConfirm={handleEditConfirm}
            onCancel={handleEditCancel}
            selectNameOnly={item.type !== 'folder'}
            autoSize
            className="mx-auto text-center"
            inputClassName="!h-[18px] !rounded !border-primary/70 !bg-background !px-1 !py-0 !text-center !text-[11px] !leading-tight !shadow-none focus:!ring-0 focus-visible:!ring-0 focus-visible:!ring-offset-0"
          />
        ) : (
          <span className={cn(
            'mx-auto block w-fit max-w-full rounded px-1 py-0.5 text-[11px] leading-tight font-normal line-clamp-2 break-words',
            isSelected ? 'bg-primary text-primary-foreground' : 'text-foreground/85'
          )}>
            {item.name}
          </span>
        )}
      </div>
    </div>
  );
});

/**
 * 可拖放的 FinderFileItem 包装组件
 *
 * 使用 useDraggable + useDroppable（仅文件夹可 drop），
 * 不再使用 sortable，避免列表项在拖拽时产生排序位移。
 * 使用 React.memo 优化虚拟滚动列表重渲染。
 */
export const SortableFinderFileItem = React.memo(function SortableFinderFileItem({
  id,
  enableDrag = true,
  ...props
}: SortableFinderFileItemProps) {
  const isFolder = props.item.type === 'folder';

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id,
    disabled: !enableDrag,
    data: {
      type: props.item.type,
      itemId: id,
    },
  });

  const {
    setNodeRef: setDropRef,
    isOver,
  } = useDroppable({
    id,
    disabled: !isFolder || isDragging,
    data: {
      type: 'folder',
      accepts: 'finder-item',
      itemId: id,
    },
  });

  // 合并 drag/drop ref（文件夹同时是拖源与放置目标）
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef]
  );

  const isDropTarget = isOver && isFolder && !isDragging;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-finder-item
      data-item-id={id}
      data-agent-entity={`files:${id}`}
      role="option"
      aria-selected={props.isSelected}
      className={props.viewMode === 'grid' ? 'w-[88px] max-w-[88px] min-w-0' : undefined}
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
