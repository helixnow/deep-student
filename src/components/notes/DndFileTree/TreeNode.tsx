import React, { useState, useRef, useEffect, useId, useCallback, forwardRef, useMemo } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronRight, ChevronDown, Star, Folder, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useTree } from './TreeContext';
import { TreeNode as TreeNodeType } from './types';
import { ReferenceIcon } from './ReferenceIcon';
import { isReferenceId } from '../types/reference';
import { InvalidReferenceIcon } from '../InvalidReferenceOverlay';

const LEVEL_INDENT = 20;
const BASE_INDENT = 16;

interface TreeNodeProps {
  id: string;
  node: TreeNodeType;
  depth: number;
  draggingId?: string | null;
  overId?: string | null;
  dropPosition?: 'before' | 'after' | 'inside';
  status?: 'none' | 'pending' | 'ok';
  searchTerm?: string;
  isSearchMatch?: boolean;
  disableToggle?: boolean;
  disableDrag?: boolean;
  style?: React.CSSProperties;
  // 用于 @tanstack/react-virtual 的测量：确保被测量元素包含 data-index
  dataIndex?: number;
}

const buildVisibleNodeList = (
  treeData: Record<string, TreeNodeType>,
  expandedIds: Set<string>,
): string[] => {
  const ids: string[] = [];
  const traverse = (nodeId: string) => {
    if (nodeId !== 'root') {
      ids.push(nodeId);
    }
    const node = treeData[nodeId];
    if (!node) return;
    if (!node.children || node.children.length === 0) return;
    if (!expandedIds.has(nodeId) && nodeId !== 'root') return;
    for (const child of node.children) {
      traverse(child);
    }
  };
  const root = treeData.root;
  if (root?.children) {
    for (const child of root.children) {
      traverse(child);
    }
  }
  return ids;
};

export const TreeNode = forwardRef<HTMLDivElement, TreeNodeProps>(function TreeNode(
  props,
  forwardedRef,
) {
  const {
    id,
    node,
    depth,
    draggingId,
    overId,
    dropPosition,
    status,
    searchTerm,
    isSearchMatch,
    disableToggle,
    disableDrag,
    style: externalStyle,
    dataIndex,
  } = props;
  const { t } = useTranslation(['notes']);
  const { state, actions, callbacks, treeData } = useTree();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLDivElement | null>(null);

  const isExpanded = state.expandedIds.has(id);
  const isSelected = state.selectedIds.has(id);
  const isFocused = state.focusedId === id;
  const isRenaming = state.renamingId === id;
  const isOver = (overId ?? state.overId) === id;
  const isOverInsideFolder = isOver && node.isFolder && (dropPosition ?? 'inside') === 'inside';
  const currentDropPosition = dropPosition ?? state.dropPosition;
  const computedPaddingLeft = BASE_INDENT + depth * LEVEL_INDENT;
  const firstRootChildId = treeData.root?.children?.[0];
  const isFirstVisible = depth === 0 && firstRootChildId === id;
  const computedTabIndex = isFocused || (!state.focusedId && isFirstVisible) ? 0 : -1;
  const normalizedTitle = (node.title ?? '').trim();
  const searchTermLower = searchTerm?.toLowerCase()?.trim() ?? '';
  const lowerTitle = normalizedTitle.toLowerCase();
  const matchIndex =
    searchTermLower && searchTermLower.length
      ? lowerTitle.indexOf(searchTermLower)
      : -1;
  const hasHighlight = matchIndex >= 0 && searchTermLower.length > 0;
  const highlightedTitle = hasHighlight
    ? (
        <>
          {normalizedTitle.slice(0, matchIndex)}
          <mark className="tree-highlight">
            {normalizedTitle.slice(matchIndex, matchIndex + searchTermLower.length)}
          </mark>
          {normalizedTitle.slice(matchIndex + searchTermLower.length)}
        </>
      )
    : normalizedTitle;

  const parentIdFromData =
    typeof (node.data as any)?.parentId === 'string'
      ? (node.data as any).parentId
      : null;
  const parentId = useMemo(() => {
    if (parentIdFromData) return parentIdFromData;
    for (const [fid, item] of Object.entries(treeData)) {
      if (item.children?.includes(id)) return fid;
    }
    return null;
  }, [parentIdFromData, treeData, id]);
  const siblingIds =
    parentId && parentId !== 'root'
      ? treeData[parentId]?.children || []
      : treeData.root?.children || [];
  const posInSet = Math.max(1, siblingIds.indexOf(id) + 1);
  const setSize = siblingIds.length || 1;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: dndIsDragging,
  } = useSortable({
    id,
    disabled: id === 'root' || !node.canMove || disableDrag,
  });

  const setRefs = useCallback(
    (element: HTMLDivElement | null) => {
      setNodeRef(element);
      if (!forwardedRef) return;
      if (typeof forwardedRef === 'function') {
        forwardedRef(element);
      } else {
        (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = element;
      }
    },
    [setNodeRef, forwardedRef],
  );

  // 拖拽时使用正常的transform，非拖拽时禁用transform避免位置错乱
  const dragStyle = {
    transform: dndIsDragging ? CSS.Transform.toString(transform) : undefined,
    transition: dndIsDragging ? transition : undefined,
    opacity: dndIsDragging ? 0.5 : 1,
    pointerEvents: dndIsDragging ? 'none' : 'auto',
  } as React.CSSProperties;

  const mergedStyle = externalStyle
    ? { ...externalStyle, ...dragStyle }
    : dragStyle;

  // 处理重命名
  useEffect(() => {
    if (isRenaming && !isEditing) {
      setIsEditing(true);
      setEditValue(node.title);
    } else if (!isRenaming && isEditing) {
      setIsEditing(false);
    }
  }, [isRenaming, isEditing, node.title]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRename = () => {
    if (editValue.trim() && editValue !== node.title) {
      callbacks.onRename?.(id, editValue.trim());
    }
    actions.endRename();
    setIsEditing(false);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      const anchor = state.anchorId ?? state.focusedId ?? id;
      actions.setAnchor(anchor);
      actions.selectRange(id);
      return;
    }
    const useMulti = e.ctrlKey || e.metaKey;
    actions.select(id, useMulti);
    actions.setAnchor(id);
    actions.focus(id);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!node.isFolder) {
      callbacks.onDoubleClick?.(id);
    }
  };

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disableToggle) {
      return;
    }
    actions.toggleExpand(id);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isSelected) {
      actions.select(id, false);
    }
    callbacks.onContextMenu?.(id, e);
  };

  // 触控端长按触发上下文菜单
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const LONG_PRESS_MS = 500;
  const MOVE_TOLERANCE = 8; // px

  // 清理长按定时器（组件卸载时）
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    };
  }, []);

  const onTouchStartCtx = (e: React.TouchEvent) => {
    try { e.stopPropagation(); } catch {}
    const t = e.touches[0];
    touchStartPos.current = { x: t.clientX, y: t.clientY };
    longPressTimer.current = setTimeout(() => {
      callbacks.onContextMenu?.(id, { clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} });
    }, LONG_PRESS_MS);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  const onTouchEndCtx = () => { cancelLongPress(); };
  const onTouchCancelCtx = () => { cancelLongPress(); };
  const onTouchMoveCtx = (e: React.TouchEvent) => {
    const start = touchStartPos.current; if (!start) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - start.x);
    const dy = Math.abs(t.clientY - start.y);
    if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) cancelLongPress();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isEditing) {
      if (e.key === 'Enter') {
        handleRename();
      } else if (e.key === 'Escape') {
        setEditValue(node.title);
        actions.endRename();
        setIsEditing(false);
      }
      return;
    }

    const moveFocusTo = (targetId: string) => {
      if (!targetId || targetId === id) return;
      actions.clearSelection();
      actions.select(targetId, false);
    };

    const visibleIds = buildVisibleNodeList(treeData, state.expandedIds);
    const currentIndex = visibleIds.indexOf(id);

    if (e.shiftKey && e.key === 'ArrowDown' && currentIndex !== -1 && currentIndex < visibleIds.length - 1) {
      e.preventDefault();
      actions.setAnchor(state.anchorId ?? id);
      actions.selectRange(visibleIds[currentIndex + 1]);
      return;
    }

    if (e.shiftKey && e.key === 'ArrowUp' && currentIndex > 0) {
      e.preventDefault();
      actions.setAnchor(state.anchorId ?? id);
      actions.selectRange(visibleIds[currentIndex - 1]);
      return;
    }

    if (e.shiftKey && e.key === 'Home' && visibleIds.length > 0) {
      e.preventDefault();
      actions.setAnchor(state.anchorId ?? id);
      actions.selectRange(visibleIds[0]);
      return;
    }

    if (e.shiftKey && e.key === 'End' && visibleIds.length > 0) {
      e.preventDefault();
      actions.setAnchor(state.anchorId ?? id);
      actions.selectRange(visibleIds[visibleIds.length - 1]);
      return;
    }

    // 处理树的键盘导航
    switch (e.key) {
      case 'ArrowRight':
        if (node.isFolder && !isExpanded) {
          e.preventDefault();
          if (!disableToggle) {
            actions.expand(id);
          }
        } else if (node.isFolder && isExpanded && node.children && node.children.length) {
          e.preventDefault();
          moveFocusTo(node.children[0]);
        }
        break;
      case 'ArrowLeft':
        if (node.isFolder && isExpanded) {
          e.preventDefault();
          if (!disableToggle) {
            actions.collapse(id);
          }
        } else {
          const parentIdValue = parentId;
          if (parentIdValue && parentIdValue !== 'root') {
            e.preventDefault();
            moveFocusTo(parentIdValue);
          }
        }
        break;
      case 'ArrowDown':
        if (currentIndex !== -1 && currentIndex < visibleIds.length - 1) {
          e.preventDefault();
          moveFocusTo(visibleIds[currentIndex + 1]);
        }
        break;
      case 'ArrowUp':
        if (currentIndex > 0) {
          e.preventDefault();
          moveFocusTo(visibleIds[currentIndex - 1]);
        }
        break;
      case 'Home': {
        if (visibleIds.length > 0) {
          e.preventDefault();
          moveFocusTo(visibleIds[0]);
        }
        break;
      }
      case 'End': {
        if (visibleIds.length > 0) {
          e.preventDefault();
          moveFocusTo(visibleIds[visibleIds.length - 1]);
        }
        break;
      }
      case 'Enter':
        if (!node.isFolder) {
          e.preventDefault();
          callbacks.onDoubleClick?.(id);
        }
        break;
      case 'F2':
        if (node.canRename !== false) {
          e.preventDefault();
          actions.startRename(id);
        }
        break;
      case 'Delete':
        if (isSelected) {
          e.preventDefault();
          callbacks.onDelete?.([...state.selectedIds]);
        }
        break;
      case 'ContextMenu':
        e.preventDefault();
        triggerKeyboardContextMenu();
        break;
      case 'F10':
        if (e.shiftKey) {
          e.preventDefault();
          triggerKeyboardContextMenu();
        }
        break;
    }
  };

  const triggerKeyboardContextMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    const clientX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const clientY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    callbacks.onContextMenu?.(id, {
      clientX,
      clientY,
      preventDefault: () => {},
    });
  };

  // 不渲染 root 节点本身，只渲染其子节点
  // 注意: root 节点不应该通过 TreeNode 组件渲染
  if (id === 'root') {
    return null;
  }

  const statusLabel =
    status === 'ok'
      ? t('notes:tree.vectorStatus.fresh')
      : status === 'pending'
        ? t('notes:tree.vectorStatus.pending')
        : t('notes:tree.vectorStatus.none');
  const statusDescriptionId = useId();
  const isFavorite = !node.isFolder && !!node.data?.note?.is_favorite;

  // ============================================================================
  // 引用节点支持
  // ============================================================================

  // 判断是否为引用节点
  const isReference = useMemo(() => {
    return node.nodeType === 'reference' || isReferenceId(id);
  }, [node.nodeType, id]);

  // 引用节点数据
  const referenceData = node.referenceData;
  const isInvalidReference = referenceData?.isInvalid ?? false;

  // 引用节点的来源数据库和预览类型
  const sourceDb = referenceData?.referenceNode?.sourceDb;
  const previewType = referenceData?.referenceNode?.previewType;

  // 引用节点失效时的提示文案
  const invalidReferenceLabel = isInvalidReference
    ? t('notes:reference.invalid')
    : undefined;

  return (
    <div
      ref={setRefs}
      style={mergedStyle}
      data-index={typeof dataIndex === 'number' ? dataIndex : undefined}
      data-dragging={dndIsDragging ? 'true' : undefined}
    >
      <div
        className={cn(
          'rct-tree-item-li',
          isSelected && 'rct-tree-item-li-selected',
          isFocused && 'rct-tree-item-li-focused',
          isOver && 'rct-tree-item-li-isOver',
          dndIsDragging && 'rct-tree-item-li-isDragging',
          isOverInsideFolder && 'rct-tree-item-li-over-inside',
          isSearchMatch && 'rct-tree-item-li-searchMatch',
          // 引用节点样式
          isReference && 'rct-tree-item-li-reference',
          isInvalidReference && 'rct-tree-item-li-invalid'
        )}
        data-tree-id={id}
        data-tree-depth={depth}
        data-tree-folder={node.isFolder ? 'true' : 'false'}
        data-tree-reference={isReference ? 'true' : 'false'}
        data-tree-invalid={isInvalidReference ? 'true' : 'false'}
        data-source-db={sourceDb}
        data-drop-position={isOver ? currentDropPosition : undefined}
        data-search-match={isSearchMatch || hasHighlight ? 'true' : 'false'}
      >
        <div
          ref={buttonRef}
          className="rct-tree-item-button"
          style={{ paddingLeft: `${computedPaddingLeft}px` }}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
          onTouchStart={onTouchStartCtx}
          onTouchEnd={onTouchEndCtx}
          onTouchCancel={onTouchCancelCtx}
          onTouchMove={onTouchMoveCtx}
          onKeyDown={handleKeyDown}
          tabIndex={computedTabIndex}
          role="treeitem"
          aria-level={depth + 1}
          aria-setsize={setSize}
          aria-posinset={posInSet}
          aria-selected={isSelected}
          aria-expanded={node.isFolder ? isExpanded : undefined}
          aria-label={normalizedTitle}
          aria-describedby={!node.isFolder ? statusDescriptionId : undefined}
          data-search-term={normalizedTitle && searchTermLower ? 'true' : 'false'}
          data-search-match={hasHighlight}
          {...attributes}
          {...listeners}
        >
          {/* 展开/折叠箭头 - 文件夹显示，引用节点和笔记显示图标 */}
          {node.isFolder ? (
            <NotionButton variant="ghost" size="icon" iconOnly className="rct-tree-item-arrow mr-2" onClick={handleExpandClick} aria-label={isExpanded ? t('notes:tree.aria.collapse') : t('notes:tree.aria.expand')} aria-expanded={isExpanded}>
              <ChevronRight className="w-3 h-3" />
            </NotionButton>
          ) : isReference && sourceDb ? (
            // 引用节点显示对应图标
            <span className="rct-tree-item-icon mr-2 flex-shrink-0">
              <ReferenceIcon
                sourceDb={sourceDb}
                previewType={previewType}
                isInvalid={isInvalidReference}
                showLinkBadge={true}
                size="sm"
              />
            </span>
          ) : (
            // 笔记节点显示文件图标
            <span className="rct-tree-item-icon mr-2 flex-shrink-0">
              <FileText className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" aria-hidden="true" />
            </span>
          )}

          {/* 标题或编辑框 */}
          <span
            className="rct-tree-item-title flex items-center gap-2"
            data-highlight={hasHighlight}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                className="rct-tree-item-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleRename}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  handleKeyDown(e);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className={cn(
                  'flex items-center gap-2',
                  // 失效引用显示删除线
                  isInvalidReference && 'line-through opacity-50'
                )}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  // 失效引用不允许双击打开
                  if (isInvalidReference) return;
                  if (node.canRename !== false) {
                    actions.startRename(id);
                  }
                }}
                title={invalidReferenceLabel}
              >
                <span>{highlightedTitle}</span>
                {isFavorite && (
                  <Star className="w-3 h-3 text-warning fill-warning" aria-hidden="true" />
                )}
                {/* 失效引用警告图标 */}
                {isReference && (
                  <InvalidReferenceIcon
                    isInvalid={isInvalidReference}
                    isValidating={referenceData?.isValidating}
                  />
                )}
              </span>
            )}
            {/* 笔记节点显示向量状态，引用节点不显示 */}
            {!node.isFolder && !isReference && (
              <>
                <span
                  className={cn(
                    'inline-block w-[8px] h-[8px] rounded-full ml-auto',
                    status === 'ok' && 'bg-success',
                    status === 'pending' && 'bg-warning',
                    status !== 'ok' && status !== 'pending' && 'bg-info'
                  )}
                  title={statusLabel}
                  role="presentation"
                />
                <span id={statusDescriptionId} className="sr-only">
                  {statusLabel}
                </span>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
});

TreeNode.displayName = 'TreeNode';
