import React, { useState, useEffect } from 'react';
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
  MeasuringStrategy,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TreeItem, TreeItemIndex, DraggingPosition } from 'react-complex-tree';

// 可排序的树节点包装器
interface SortableTreeItemProps {
  id: string;
  children: React.ReactNode;
  depth?: number;
}

export function SortableTreeItem({ id, children, depth = 0 }: SortableTreeItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    paddingLeft: `${depth * 20}px`,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

// DnD-Kit 树适配器组件
interface DndKitTreeAdapterProps {
  items: Record<string, TreeItem<any>>;
  onDrop: (draggedItems: TreeItem<any>[], target: DraggingPosition) => void;
  children: React.ReactNode;
  canDrag?: (items: TreeItem<any>[]) => boolean;
  canDropAt?: (items: TreeItem<any>[], target: DraggingPosition) => boolean;
}

export function DndKitTreeAdapter({ 
  items, 
  onDrop, 
  children,
  canDrag,
  canDropAt 
}: DndKitTreeAdapterProps) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  
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

  // 获取所有项的 ID 列表（扁平化）
  const getAllItemIds = (): string[] => {
    const ids: string[] = [];
    const traverse = (itemId: string) => {
      ids.push(itemId);
      const item = items[itemId];
      if (item?.children) {
        item.children.forEach(childId => traverse(String(childId)));
      }
    };
    Object.keys(items).forEach(id => {
      if (id === 'root') {
        const root = items.root;
        if (root?.children) {
          root.children.forEach(childId => traverse(String(childId)));
        }
      }
    });
    return ids;
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
    console.log('🎯 DnD-Kit: Start dragging', event.active.id);
  };

  const handleDragOver = (event: DragOverEvent) => {
    setOverId(event.over?.id || null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    
    if (!over || active.id === over.id) {
      setActiveId(null);
      setOverId(null);
      return;
    }

    console.log('✅ DnD-Kit: Drop', active.id, 'on', over.id);
    
    // 构造 react-complex-tree 期望的格式
    const draggedItem = items[String(active.id)];
    if (!draggedItem) return;

    // 判断目标类型
    let target: DraggingPosition;
    const targetItem = items[String(over.id)];
    
    if (targetItem?.isFolder) {
      // 拖到文件夹上
      target = {
        targetType: 'item',
        targetItem: over.id as TreeItemIndex,
        parentItem: over.id as TreeItemIndex,
        depth: 0,
        linearIndex: 0,
      } as DraggingPosition;
    } else {
      // 拖到普通项上（作为兄弟）
      // 找到目标项的父级
      let parentId = 'root';
      for (const [id, item] of Object.entries(items)) {
        if (item.children?.includes(over.id as TreeItemIndex)) {
          parentId = id;
          break;
        }
      }
      
      const parentChildren = items[parentId]?.children || [];
      const targetIndex = parentChildren.indexOf(over.id as TreeItemIndex);
      
      target = {
        targetType: 'between-items',
        parentItem: parentId as TreeItemIndex,
        depth: 0,
        linearIndex: 0,
        childIndex: targetIndex + 1,
        linePosition: 'bottom',
      } as DraggingPosition;
    }

    // 调用原始的 onDrop 处理函数
    onDrop([draggedItem], target);
    
    setActiveId(null);
    setOverId(null);
  };

  const itemIds = getAllItemIds();

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      measuring={{
        droppable: {
          strategy: MeasuringStrategy.Always,
        },
      }}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
      
      <DragOverlay>
        {activeId ? (
          <div className="opacity-80 bg-accent/20 p-2 rounded border border-primary">
            {items[String(activeId)]?.data?.title || String(activeId)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// Hook: 增强树节点以支持 DnD-Kit
export function useDndKitTreeItem(itemId: string) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: itemId });

  return {
    dndProps: {
      ref: setNodeRef,
      style: {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      },
      ...attributes,
      ...listeners,
    },
    isDragging,
  };
}