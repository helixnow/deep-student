// 文件树类型定义

import type { ReferenceNode, SourceDatabase, PreviewType } from '../types/reference';

/**
 * 节点类型标识
 * - note: 笔记节点（原生）
 * - folder: 文件夹节点
 * - reference: 引用节点（新增）
 */
export type NodeType = 'note' | 'folder' | 'reference';

/**
 * 引用节点附加数据
 */
export interface ReferenceData {
  /** 引用节点信息 */
  referenceNode: ReferenceNode;
  /** 是否失效（原数据已删除） */
  isInvalid?: boolean;
  /** 是否正在校验中 */
  isValidating?: boolean;
}

export interface TreeNode {
  id: string;
  title: string;
  isFolder: boolean;
  children?: string[];
  data?: any;
  canMove?: boolean;
  canRename?: boolean;
  /** 节点类型（新增，用于区分笔记/文件夹/引用） */
  nodeType?: NodeType;
  /** 引用节点数据（仅 nodeType='reference' 时存在） */
  referenceData?: ReferenceData;
}

// 导出引用相关类型供外部使用
export type { ReferenceNode, SourceDatabase, PreviewType };

export type TreeData = Record<string, TreeNode>;

export interface DragInfo {
  draggedIds: string[];
  targetId: string;
  position: 'before' | 'after' | 'inside';
}

export interface TreeState {
  expandedIds: Set<string>;
  selectedIds: Set<string>;
  focusedId: string | null;
  anchorId: string | null;
  renamingId: string | null;
  draggedId: string | null;
  overId: string | null;
  dropPosition: 'before' | 'after' | 'inside';
}

export interface TreeActions {
  expand: (id: string) => void;
  collapse: (id: string) => void;
  toggleExpand: (id: string) => void;
  select: (id: string, multi?: boolean) => void;
  selectRange: (id: string) => void;
  clearSelection: () => void;
  focus: (id: string) => void;
  setAnchor: (id: string | null) => void;
  startRename: (id: string) => void;
  endRename: () => void;
  setDraggedId: (id: string | null) => void;
  setOverId: (id: string | null) => void;
  setDropPosition: (position: 'before' | 'after' | 'inside') => void;
}

export interface TreeCallbacks {
  onExpand?: (id: string) => void;
  onCollapse?: (id: string) => void;
  onSelect?: (ids: string[]) => void;
  onFocus?: (id: string) => void;
  onRename?: (id: string, newName: string) => void;
  onDrop?: (dragInfo: DragInfo) => void;
  onDoubleClick?: (id: string) => void;
  // 允许鼠标右键与触控长按传入的事件（只消费 clientX/clientY/preventDefault）
  onContextMenu?: (id: string, event: { clientX: number; clientY: number; preventDefault?: () => void } | React.MouseEvent) => void;
  onDelete?: (ids: string[]) => void;
  onCopy?: (ids: string[]) => void;
  onPaste?: (targetId: string) => void;
}
