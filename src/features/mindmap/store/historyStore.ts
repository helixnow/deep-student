/**
 * 历史状态管理（撤销/重做）
 * 
 * 职责：管理操作历史，支持撤销和重做
 */

import { create } from 'zustand';
import type { MindMapNode } from '../types';

/** 历史记录项 */
export interface HistoryItem {
  /** 操作描述 */
  description: string;
  /** 操作前的状态（完整的根节点） */
  state: MindMapNode;
  /** 时间戳 */
  timestamp: number;
}

/** 历史状态 */
export interface HistoryState {
  /** 历史记录栈 */
  undoStack: HistoryItem[];
  /** 重做栈 */
  redoStack: HistoryItem[];
  /** 最大历史记录数 */
  maxHistory: number;
  /** 是否可以撤销 */
  canUndo: boolean;
  /** 是否可以重做 */
  canRedo: boolean;
}

/** 历史操作 */
export interface HistoryActions {
  /** 记录状态变更 */
  record: (description: string, state: MindMapNode) => void;
  /** 撤销 */
  undo: () => MindMapNode | null;
  /** 重做 */
  redo: () => MindMapNode | null;
  /** 清空历史 */
  clear: () => void;
  /** 设置最大历史记录数 */
  setMaxHistory: (max: number) => void;
}

export type HistoryStore = HistoryState & HistoryActions;

/** 默认最大历史记录数 */
const DEFAULT_MAX_HISTORY = 50;

/** 创建历史 Store */
export const useHistoryStore = create<HistoryStore>()((set, get) => ({
  // 初始状态
  undoStack: [],
  redoStack: [],
  maxHistory: DEFAULT_MAX_HISTORY,
  canUndo: false,
  canRedo: false,

  // 记录状态变更
  record: (description, state) => {
    set(s => {
      const newItem: HistoryItem = {
        description,
        state: structuredClone(state),
        timestamp: Date.now(),
      };

      // 添加到撤销栈
      let newUndoStack = [...s.undoStack, newItem];
      
      // 限制历史记录数量
      if (newUndoStack.length > s.maxHistory) {
        newUndoStack = newUndoStack.slice(-s.maxHistory);
      }

      return {
        undoStack: newUndoStack,
        redoStack: [], // 新操作清空重做栈
        canUndo: newUndoStack.length > 0,
        canRedo: false,
      };
    });
  },

  // 撤销
  undo: () => {
    const { undoStack, redoStack } = get();
    
    if (undoStack.length === 0) return null;

    // 弹出最后一个状态
    const item = undoStack[undoStack.length - 1];
    const newUndoStack = undoStack.slice(0, -1);

    set({
      undoStack: newUndoStack,
      redoStack: [item, ...redoStack],
      canUndo: newUndoStack.length > 0,
      canRedo: true,
    });

    // 返回上一个状态（如果有的话）
    if (newUndoStack.length > 0) {
      return structuredClone(newUndoStack[newUndoStack.length - 1].state);
    }
    
    return null;
  },

  // 重做
  redo: () => {
    const { undoStack, redoStack } = get();
    
    if (redoStack.length === 0) return null;

    // 取出第一个状态
    const [item, ...newRedoStack] = redoStack;
    const newUndoStack = [...undoStack, item];

    set({
      undoStack: newUndoStack,
      redoStack: newRedoStack,
      canUndo: true,
      canRedo: newRedoStack.length > 0,
    });

    return structuredClone(item.state);
  },

  // 清空历史
  clear: () => {
    set({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },

  // 设置最大历史记录数
  setMaxHistory: (max) => {
    set(s => {
      const newUndoStack = s.undoStack.length > max 
        ? s.undoStack.slice(-max) 
        : s.undoStack;
      
      return {
        maxHistory: max,
        undoStack: newUndoStack,
        canUndo: newUndoStack.length > 0,
      };
    });
  },
}));

