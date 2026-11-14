/**
 * Crepe 编辑器调试：日志级别与事件分类、DOM / 编辑器快照的结构、日志条目与上报内容，
 * 以及级别配色、图标和分类的中文标签、图标、颜色。
 */

import type React from 'react';
import {
  Warning, CheckCircle, XCircle,
  ArrowClockwise, Eye, Play, Gear, Code
} from '@phosphor-icons/react';

// ============ 类型定义 ============

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export type EventCategory = 
  | 'lifecycle'       // 生命周期：mount/unmount/create/destroy
  | 'init'            // 初始化：container/Crepe实例/配置
  | 'dependency'      // 依赖：Prism/插件加载
  | 'dom'             // DOM状态：data-ready/contentEditable
  | 'editor'          // 编辑器事件：focus/blur/change
  | 'error'           // 错误捕获
  | 'snapshot';       // 状态快照

export interface DOMSnapshot {
  wrapperExists: boolean;
  dataReady: string | null;
  milkdownExists: boolean;
  proseMirrorExists: boolean;
  contentEditable: string | null;
  pointerEvents: string | null;
  opacity: string | null;
  wrapperClassName: string;
  childCount: number;
}

export interface EditorSnapshot {
  crepeExists: boolean;
  isReady: boolean;
  readonly: boolean;
  noteId: string | null;
  subject?: string | null;
  markdownLength: number;
}

export interface DebugLog {
  id: string;
  ts: number;
  category: EventCategory;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  domSnapshot?: DOMSnapshot;
  editorSnapshot?: EditorSnapshot;
}

export interface CrepeDebugEventDetail {
  category: EventCategory;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  domSnapshot?: DOMSnapshot;
  editorSnapshot?: EditorSnapshot;
}

// ============ 常量 ============

export const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',
};

export const LEVEL_ICONS: Record<LogLevel, React.FC<any>> = {
  debug: ArrowClockwise,
  info: CheckCircle,
  warning: Warning,
  error: XCircle,
};

export const CATEGORY_LABELS: Record<EventCategory, { label: string; icon: React.FC<any>; color: string }> = {
  lifecycle: { label: '生命周期', icon: ArrowClockwise, color: '#8b5cf6' },
  init: { label: '初始化', icon: Gear, color: '#6366f1' },
  dependency: { label: '依赖加载', icon: Code, color: '#10b981' },
  dom: { label: 'DOM状态', icon: Eye, color: '#f97316' },
  editor: { label: '编辑器事件', icon: Play, color: '#3b82f6' },
  error: { label: '错误', icon: XCircle, color: '#ef4444' },
  snapshot: { label: '状态快照', icon: Eye, color: '#06b6d4' },
};
