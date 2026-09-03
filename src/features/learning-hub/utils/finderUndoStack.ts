/**
 * Finder 最近操作撤销栈（移动 / 重命名）
 *
 * 刻意保持轻量：只是一个有上限的 LIFO 栈，记录「怎么反做」所需的最小信息，
 * 不做完整事务系统（无 redo、无跨会话持久化、失败不回滚重放）。
 * 软删除的撤销走通知内的 Undo 按钮（LH-UNDO），不进本栈。
 */

import type { FolderItemType } from '@/dstu/types/folder';

/** 重命名操作记录 */
export interface FinderRenameUndoOp {
  kind: 'rename';
  targetType: 'folder' | 'resource';
  /** 资源 / 文件夹 ID */
  id: string;
  /** 资源的 DSTU 路径（重命名不改路径叶子，可直接用于反向 rename） */
  path: string | null;
  oldName: string;
  newName: string;
}

/** 移动操作单项 */
export interface FinderMoveUndoEntry {
  id: string;
  isFolder: boolean;
  /** 非文件夹时的 folderApi.moveItem 类型 */
  itemType: FolderItemType | null;
  /** 移动前所在文件夹（null = 根目录） */
  fromFolderId: string | null;
}

/** 移动操作记录（单个或批量共用） */
export interface FinderMoveUndoOp {
  kind: 'move';
  entries: FinderMoveUndoEntry[];
  toFolderId: string | null;
}

export type FinderUndoOp = FinderRenameUndoOp | FinderMoveUndoOp;

export const FINDER_UNDO_STACK_LIMIT = 20;

export interface FinderUndoStack {
  push: (op: FinderUndoOp) => void;
  pop: () => FinderUndoOp | null;
  clear: () => void;
  size: () => number;
}

export function createFinderUndoStack(limit: number = FINDER_UNDO_STACK_LIMIT): FinderUndoStack {
  const ops: FinderUndoOp[] = [];
  return {
    push: (op) => {
      ops.push(op);
      if (ops.length > limit) {
        ops.splice(0, ops.length - limit);
      }
    },
    pop: () => ops.pop() ?? null,
    clear: () => {
      ops.length = 0;
    },
    size: () => ops.length,
  };
}

/**
 * 全局单例：finderStore 本身是全局单例（多个 files 宿主共享同一列表状态），
 * 撤销栈保持同样的作用域语义。
 */
export const finderUndoStack = createFinderUndoStack();
