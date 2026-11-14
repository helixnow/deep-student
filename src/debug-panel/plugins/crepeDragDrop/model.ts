/**
 * Crepe 拖放调试：事件日志的数据模型、事件类型的配色与图标、全局事件通道名。
 */

import type React from 'react';
import {
  Play, Pause, CheckCircle, XCircle, DotsSixVertical,
  Cursor, Target, ArrowDown
} from '@phosphor-icons/react';

// ============ 类型定义 ============

export type DragEventType = 
  | 'mousedown'
  | 'mouseup'
  | 'dragstart'
  | 'drag'
  | 'dragover'
  | 'dragenter'
  | 'dragleave'
  | 'drop'
  | 'dragend'
  | 'pointerdown'
  | 'pointerup';

export interface DragEventLog {
  id: string;
  ts: number;
  type: DragEventType;
  phase: 'capture' | 'bubble';
  target: string;
  currentTarget: string;
  relatedTarget?: string;
  clientX: number;
  clientY: number;
  dataTransfer?: {
    effectAllowed: string;
    dropEffect: string;
    types: string[];
    hasData: boolean;
  };
  defaultPrevented: boolean;
  propagationStopped: boolean;
  immediatePropagationStopped: boolean;
  // 状态快照
  editorState?: {
    hasFocus: boolean;
    isDragging: boolean;
    hasSelection: boolean;
    selectionType: string;
    draggingSlice: boolean;
  };
  blockHandleState?: {
    visible: boolean;
    activeNodeType: string | null;
    position: { x: number; y: number } | null;
  };
  domState?: {
    draggableElements: number;
    blockHandleExists: boolean;
    dataDragging: string | null;
    // 增强调试字段
    blockHandleDraggable?: boolean;
    blockHandlePointerEvents?: string;
    blockHandleDataShow?: string;
    operationItemCount?: number;
    pmViewExists?: boolean;
    pmViewDragging?: { slice: boolean; move: boolean } | null;
    pmViewEditable?: boolean;
    pmSelectionType?: string;
  };
  // 诊断信息
  issues: string[];
}

export interface DiagnosisResult {
  category: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: string;
}

// ============ 常量 ============

export const EVENT_COLORS: Record<DragEventType, string> = {
  mousedown: '#6366f1',
  mouseup: '#8b5cf6',
  pointerdown: '#a855f7',
  pointerup: '#c084fc',
  dragstart: '#22c55e',
  drag: '#84cc16',
  dragover: '#eab308',
  dragenter: '#f97316',
  dragleave: '#ef4444',
  drop: '#10b981',
  dragend: '#06b6d4',
};

export const EVENT_ICONS: Record<DragEventType, React.FC<any>> = {
  mousedown: Cursor,
  mouseup: Cursor,
  pointerdown: Cursor,
  pointerup: Cursor,
  dragstart: Play,
  drag: DotsSixVertical,
  dragover: Target,
  dragenter: ArrowDown,
  dragleave: XCircle,
  drop: CheckCircle,
  dragend: Pause,
};

// ============ 全局事件通道 ============

export const CREPE_DRAG_DEBUG_EVENT = 'crepe-drag-drop-debug';

export interface CrepeDragDebugEventDetail {
  type: DragEventType;
  phase: 'capture' | 'bubble';
  target: string;
  currentTarget: string;
  relatedTarget?: string;
  clientX: number;
  clientY: number;
  dataTransfer?: DragEventLog['dataTransfer'];
  defaultPrevented: boolean;
  propagationStopped: boolean;
  immediatePropagationStopped: boolean;
  editorState?: DragEventLog['editorState'];
  blockHandleState?: DragEventLog['blockHandleState'];
  domState?: DragEventLog['domState'];
  issues: string[];
}
