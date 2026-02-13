import React, { useState, useRef, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText } from 'lucide-react';

// 树节点类型
interface TreeNode {
  index: string;
  isFolder: boolean;
  children?: string[];
  data?: {
    title: string;
    note?: any;
  };
}

interface TreeWithDndKitProps {
  items: Record<string, TreeNode>;
  expandedItems: string[];
  selectedItems: string[];
  focusedItem: string;
  onExpandItem: (id: string) => void;
  onCollapseItem: (id: string) => void;
  onSelectItem: (id: string) => void;
  onFocusItem: (id: string) => void;
  onRenameItem: (id: string, name: string) => void;
  onPrimaryAction: (id: string) => void;
  onDrop: (draggedIds: string[], targetId: string, position: 'before' | 'after' | 'inside') => void;
}

// 可排序的树节点
function SortableTreeNode({ 
  id, 
  item, 
  depth = 0,
  isExpanded,
  isSelected,
  isFocused,
  onToggle,
  onClick,
  onDoubleClick,
  children: childrenNodes
}: {
  id: string;
  item: TreeNode;
  depth?: number;
  isExpanded: boolean;
  isSelected: boolean;
  isFocused: boolean;
  onToggle: () => void;
  onClick: () => void;
  onDoubleClick: () => void;
  children?: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id,
    disabled: id === 'root'
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  if (id === 'root') {
    return <>{childrenNodes}</>;
  }

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={`
          flex items-center gap-1 px-2 py-1 hover:bg-accent/50 cursor-pointer select-none
          ${isSelected ? 'bg-accent' : ''}
          ${isFocused ? 'ring-1 ring-primary/50' : ''}
        `}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        {...attributes}
        {...listeners}
      >
        {/* 展开/折叠箭头 */}
        {item.isFolder && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="p-0.5 hover:bg-accent rounded"
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
        )}
        
        {/* 图标 */}
        <span className="flex-shrink-0">
          {item.isFolder ? (
            isExpanded ? <FolderOpen className="w-4 h-4" /> : <Folder className="w-4 h-4" />
          ) : (
            <FileText className="w-4 h-4" />
          )}
        </span>
        
        {/* 标题 */}
        <span className="truncate text-sm">{(item as any).title || item.data?.title || ''}</span>
      </div>
      
      {/* 子节点 */}
      {isExpanded && childrenNodes && (
        <div>{childrenNodes}</div>
      )}
    </div>
  );
}

// 主树组件
export function TreeWithDndKit({
  items,
  expandedItems,
  selectedItems,
  focusedItem,
  onExpandItem,
  onCollapseItem,
  onSelectItem,
  onFocusItem,
  onRenameItem,
  onPrimaryAction,
  onDrop,
}: TreeWithDndKitProps) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside'>('inside');
  
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // 获取所有展开的节点ID（用于 SortableContext）
  const getAllVisibleIds = (): string[] => {
    const ids: string[] = [];
    
    const traverse = (itemId: string, parentExpanded: boolean = true) => {
      if (!parentExpanded || !items[itemId]) return;
      
      ids.push(itemId);
      
      if (items[itemId].isFolder && expandedItems.includes(itemId)) {
        const children = items[itemId].children || [];
        children.forEach(childId => traverse(childId, true));
      }
    };
    
    // 从 root 开始遍历
    const root = items.root;
    if (root?.children) {
      root.children.forEach(childId => traverse(childId));
    }
    
    return ids;
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
    console.log('🎯 Start dragging:', event.active.id);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over, collisions } = event;
    if (!over) {
      setOverId(null);
      return;
    }
    
    setOverId(over.id);
    
    // 根据碰撞位置判断是放在内部还是前后
    if (collisions && collisions.length > 0) {
      const collision = collisions[0];
      const overItem = items[String(over.id)];
      
      if (overItem?.isFolder) {
        setDropPosition('inside');
      } else {
        // 根据 Y 坐标判断是前还是后
        const rect = collision.data?.droppableContainer?.rect;
        if (rect && event.activatorEvent) {
          const mouseY = (event.activatorEvent as MouseEvent).clientY;
          const itemCenterY = rect.current?.top + rect.current?.height / 2;
          setDropPosition(mouseY < itemCenterY ? 'before' : 'after');
        }
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    
    if (!over || active.id === over.id) {
      setActiveId(null);
      setOverId(null);
      return;
    }

    console.log('✅ Drop', active.id, 'on', over.id, 'position:', dropPosition);
    
    onDrop([String(active.id)], String(over.id), dropPosition);
    
    setActiveId(null);
    setOverId(null);
    setDropPosition('inside');
  };

  // 递归渲染树节点
  const renderTree = (itemId: string, depth: number = 0): React.ReactNode => {
    const item = items[itemId];
    if (!item) return null;
    
    const isExpanded = expandedItems.includes(itemId);
    const isSelected = selectedItems.includes(itemId);
    const isFocused = focusedItem === itemId;
    
    const children = item.children || [];
    const childrenNodes = isExpanded && children.length > 0 ? (
      <div>
        {children.map(childId => renderTree(childId, depth + 1))}
      </div>
    ) : null;
    
    return (
      <SortableTreeNode
        key={itemId}
        id={itemId}
        item={item}
        depth={depth}
        isExpanded={isExpanded}
        isSelected={isSelected}
        isFocused={isFocused}
        onToggle={() => {
          if (isExpanded) {
            onCollapseItem(itemId);
          } else {
            onExpandItem(itemId);
          }
        }}
        onClick={() => {
          onFocusItem(itemId);
          onSelectItem(itemId);
        }}
        onDoubleClick={() => {
          if (!item.isFolder) {
            onPrimaryAction(itemId);
          }
        }}
      >
        {childrenNodes}
      </SortableTreeNode>
    );
  };

  const visibleIds = getAllVisibleIds();

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
        <div className="w-full">
          {renderTree('root')}
        </div>
      </SortableContext>
      
      <DragOverlay>
        {activeId && items[String(activeId)] ? (
          <div className="opacity-80 bg-accent/80 backdrop-blur px-2 py-1 rounded border border-primary shadow-lg">
            <div className="flex items-center gap-1">
              {items[String(activeId)].isFolder ? (
                <Folder className="w-4 h-4" />
              ) : (
                <FileText className="w-4 h-4" />
              )}
              <span className="text-sm">{items[String(activeId)].data?.title || ''}</span>
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}