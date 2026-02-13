/**
 * ResourceGridView - 资源图标视图组件（Finder 风格网格布局）
 *
 * 根据文档20《统一资源库与访达层改造任务分配》Prompt 5 实现
 *
 * 功能：
 * 1. 网格样式显示资源（缩略图 + 名称）
 * 2. 支持笔记、引用节点、文件夹
 * 3. 支持选中、双击、右键菜单
 * 4. 支持亮色/暗色模式
 */

import React, { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
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
  AudioFileIcon,
  VideoFileIcon,
  type ResourceIconProps,
} from './icons';
import { cn } from '@/lib/utils';
import type {
  TreeData,
  TreeNode as TreeNodeType,
} from '@/components/notes/DndFileTree/types';
import type { SourceDatabase, PreviewType } from '@/components/notes/types/reference';
import { isReferenceId } from '@/components/notes/types/reference';

// ============================================================================
// 类型定义
// ============================================================================

export interface ResourceGridViewProps {
  /** 树数据 */
  treeData: TreeData;
  /** 根节点子项（用于显示当前文件夹内容） */
  rootChildren?: string[];
  /** 选中的节点 ID 列表 */
  selectedIds?: string[];
  /** 笔记状态映射 */
  noteStatus?: Record<string, 'none' | 'pending' | 'ok'>;
  /** 单击选中 */
  onSelect?: (id: string) => void;
  /** 双击打开 */
  onDoubleClick?: (id: string) => void;
  /** 右键菜单 */
  onContextMenu?: (id: string, event: React.MouseEvent) => void;
  /** 额外的 className */
  className?: string;
  /** 网格列数（默认 4） */
  columns?: number;
  /** 网格间距（默认 16px） */
  gap?: number;
}

export interface ResourceGridItemProps {
  /** 节点 ID */
  id: string;
  /** 节点数据 */
  node: TreeNodeType;
  /** 是否选中 */
  isSelected?: boolean;
  /** 笔记状态 */
  status?: 'none' | 'pending' | 'ok';
  /** 单击选中 */
  onSelect?: (id: string) => void;
  /** 双击打开 */
  onDoubleClick?: (id: string) => void;
  /** 右键菜单 */
  onContextMenu?: (id: string, event: React.MouseEvent) => void;
}

// ============================================================================
// 自定义图标配置
// ============================================================================

/** 资源类型到自定义图标的映射 */
const RESOURCE_TYPE_ICON_MAP: Record<string, React.FC<ResourceIconProps>> = {
  note: NoteIcon,
  textbook: TextbookIcon,
  exam: ExamIcon,
  essay: EssayIcon,
  translation: TranslationIcon,
  mindmap: MindmapIcon,
  folder: FolderIcon,
  image: ImageFileIcon,
  file: GenericFileIcon,
  audio: AudioFileIcon,
  video: VideoFileIcon,
};

/** SourceDatabase 到资源类型的映射 */
const SOURCE_DB_TYPE_MAP: Record<SourceDatabase, string> = {
  textbooks: 'textbook',
  chat_v2: 'file',
  exam_sessions: 'exam',
};

/** PreviewType 到资源类型的映射 */
const PREVIEW_TYPE_MAP: Partial<Record<PreviewType, string>> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  none: 'file',
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取节点的资源类型
 */
function getNodeResourceType(node: TreeNodeType, id: string): string {
  // 文件夹
  if (node.isFolder) {
    return 'folder';
  }

  // 引用节点
  const isReference = node.nodeType === 'reference' || isReferenceId(id);
  if (isReference && node.referenceData) {
    const { referenceNode, isInvalid } = node.referenceData;
    if (isInvalid) {
      return 'invalid';
    }

    const sourceDb = referenceNode?.sourceDb;
    const previewType = referenceNode?.previewType;

    // chat_v2 需要根据 previewType 细分
    if (sourceDb === 'chat_v2' && previewType) {
      return PREVIEW_TYPE_MAP[previewType] || 'file';
    }

    // 其他 sourceDb
    if (sourceDb) {
      return SOURCE_DB_TYPE_MAP[sourceDb] || 'file';
    }
  }

  // 知识导图（通过 type 或 id 前缀判断）
  if ((node as any).type === 'mindmap' || id.startsWith('mm_')) {
    return 'mindmap';
  }

  // 根据节点类型判断
  const nodeType = (node as any).type;
  if (nodeType && RESOURCE_TYPE_ICON_MAP[nodeType]) {
    return nodeType;
  }

  return 'note';
}

/**
 * 获取节点图标组件
 */
function getNodeIconComponent(node: TreeNodeType, id: string): React.FC<ResourceIconProps> | null {
  const resourceType = getNodeResourceType(node, id);
  
  if (resourceType === 'invalid') {
    return null; // 失效引用使用 AlertTriangle
  }
  
  return RESOURCE_TYPE_ICON_MAP[resourceType] || NoteIcon;
}

// ============================================================================
// 子组件：单个网格项
// ============================================================================

const ResourceGridItem = memo(function ResourceGridItem({
  id,
  node,
  isSelected = false,
  status,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: ResourceGridItemProps) {
  const { t } = useTranslation(['learningHub', 'notes']);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect?.(id);
  }, [id, onSelect]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick?.(id);
  }, [id, onDoubleClick]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(id, e);
  }, [id, onContextMenu]);

  const IconComponent = useMemo(() => getNodeIconComponent(node, id), [node, id]);
  const resourceType = useMemo(() => getNodeResourceType(node, id), [node, id]);

  // 引用节点判断
  const isReference = node.nodeType === 'reference' || isReferenceId(id);
  const isInvalidReference = isReference && node.referenceData?.isInvalid;

  // 显示标题
  const title = node.title || t('learningHub:grid.untitled');
  const truncatedTitle = title.length > 20 ? `${title.slice(0, 18)}...` : title;

  return (
    <div
      className={cn(
        'group relative flex flex-col items-center justify-center',
        'p-3 rounded-lg cursor-pointer transition-colors duration-150',
        'border border-transparent',
        // 默认状态
        'hover:bg-muted/50 dark:hover:bg-muted/30',
        // 选中状态
        isSelected && [
          'bg-primary/10 dark:bg-primary/20',
          'border-primary/40 dark:border-primary/50',
        ],
        // 失效引用
        isInvalidReference && 'opacity-50'
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      data-grid-id={id}
      data-grid-type={node.isFolder ? 'folder' : isReference ? 'reference' : 'note'}
      data-grid-selected={isSelected}
      data-grid-invalid={isInvalidReference}
    >
      {/* 自定义 SVG 图标 */}
      <div className="mb-2">
        {resourceType === 'invalid' ? (
          <div
            className={cn(
              'flex items-center justify-center',
              'w-12 h-12 rounded-lg',
              'bg-yellow-100 dark:bg-yellow-900/30'
            )}
          >
            <AlertTriangle className="w-6 h-6 text-yellow-500" />
          </div>
        ) : IconComponent ? (
          <IconComponent
            size={48}
            className={cn(
              'transition-transform duration-150',
              'group-hover:scale-105',
              isSelected && 'scale-105'
            )}
          />
        ) : null}
      </div>

      {/* 标题 */}
      <span
        className={cn(
          'text-xs text-center leading-tight',
          'text-foreground dark:text-foreground',
          'max-w-full px-1',
          // 失效引用显示删除线
          isInvalidReference && 'line-through'
        )}
        title={title}
      >
        {truncatedTitle}
      </span>

      {/* 笔记状态指示器（仅非引用笔记显示） */}
      {!node.isFolder && !isReference && status && (
        <div
          className={cn(
            'absolute top-2 right-2',
            'w-2 h-2 rounded-full',
            status === 'ok' && 'bg-success',
            status === 'pending' && 'bg-warning',
            status === 'none' && 'bg-info'
          )}
          title={t(`notes:tree.vectorStatus.${status}`)}
        />
      )}

      {/* 失效引用警告角标 */}
      {isInvalidReference && (
        <div
          className="absolute top-2 left-2"
          title={t('notes:reference.invalid')}
        >
          <AlertTriangle className="w-3 h-3 text-yellow-500" />
        </div>
      )}
    </div>
  );
});

// ============================================================================
// 主组件：资源网格视图
// ============================================================================

export const ResourceGridView = memo(function ResourceGridView({
  treeData,
  rootChildren,
  selectedIds = [],
  noteStatus,
  onSelect,
  onDoubleClick,
  onContextMenu,
  className,
  columns = 4,
  gap = 16,
}: ResourceGridViewProps) {
  const { t } = useTranslation(['learningHub', 'notes']);

  // 计算要显示的节点列表
  const displayNodes = useMemo(() => {
    // 优先使用 rootChildren（当前文件夹内容）
    const childIds = rootChildren || treeData.root?.children || [];
    return childIds
      .map((id) => ({ id, node: treeData[id] }))
      .filter((item) => item.node != null);
  }, [treeData, rootChildren]);

  // 选中 ID Set 便于快速查找
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // 空状态
  if (displayNodes.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center',
          'py-12 text-muted-foreground',
          className
        )}
      >
        <FolderIcon size={48} className="mb-4 opacity-30" />
        <span className="text-sm">{t('learningHub:grid.empty')}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'grid',
        className
      )}
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: `${gap}px`,
      }}
      role="grid"
      aria-label={t('learningHub:grid.ariaLabel')}
    >
      {displayNodes.map(({ id, node }) => (
        <ResourceGridItem
          key={id}
          id={id}
          node={node}
          isSelected={selectedSet.has(id)}
          status={noteStatus?.[id]}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
});

export default ResourceGridView;
