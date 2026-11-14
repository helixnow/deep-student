/**
 * Crepe 图片上传调试：日志级别与阶段、DOM 信息 / 选择器匹配 / ImageBlock 快照的结构、日志条目与上报内容，
 * 以及级别配色和阶段的中文标签、图标、颜色。
 */

import type React from 'react';
import {
  ArrowClockwise, Eye, Image, Upload,
  Cursor, FileImage, CheckCircle, XCircle,
  Folder, Code, Lightning, Camera
} from '@phosphor-icons/react';

// ============ 类型定义 ============

export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'success';

export type EventStage = 
  | 'click_detected'      // 检测到点击
  | 'selector_check'      // 选择器检查
  | 'tauri_check'         // Tauri 环境检查
  | 'dialog_open'         // 打开文件对话框
  | 'dialog_result'       // 对话框结果
  | 'file_read'           // 文件读取
  | 'file_convert'        // 文件转换
  | 'upload_start'        // 开始上传
  | 'upload_complete'     // 上传完成
  | 'node_find'           // 查找节点
  | 'node_update'         // 更新节点
  | 'node_insert'         // 插入节点
  | 'dom_snapshot'        // DOM 快照
  | 'image_render'        // 图片渲染状态
  | 'error';              // 错误

export interface DOMInfo {
  tagName: string;
  className: string;
  id: string;
  innerText?: string;
  attributes: Record<string, string>;
}

export interface SelectorMatchResult {
  selector: string;
  matched: boolean;
  matchedElement?: DOMInfo;
}

export interface ImageBlockDOMSnapshot {
  hasImageBlock: boolean;
  hasImageInline: boolean;
  hasImageEdit: boolean;
  hasPlaceholder: boolean;
  hasUploader: boolean;
  hasHiddenInput: boolean;
  hiddenInputId?: string;
  uploaderForAttr?: string;
  imageBlockClasses: string[];
  fullDOMPath: string[];
}

export interface DebugLog {
  id: string;
  ts: number;
  stage: EventStage;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  domInfo?: DOMInfo;
  selectorMatches?: SelectorMatchResult[];
  imageBlockSnapshot?: ImageBlockDOMSnapshot;
}

export interface CrepeImageUploadDebugEventDetail {
  stage: EventStage;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  domInfo?: DOMInfo;
  selectorMatches?: SelectorMatchResult[];
  imageBlockSnapshot?: ImageBlockDOMSnapshot;
}

// ============ 常量 ============

export const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',
  success: '#22c55e',
};

export const LEVEL_BG: Record<LogLevel, string> = {
  debug: '#f3f4f6',
  info: '#eff6ff',
  warning: '#fffbeb',
  error: '#fef2f2',
  success: '#f0fdf4',
};

export const STAGE_LABELS: Record<EventStage, { label: string; icon: React.FC<any>; color: string }> = {
  click_detected: { label: '点击检测', icon: Cursor, color: '#8b5cf6' },
  selector_check: { label: '选择器检查', icon: Code, color: '#6366f1' },
  tauri_check: { label: 'Tauri检测', icon: Lightning, color: '#10b981' },
  dialog_open: { label: '打开对话框', icon: Folder, color: '#f97316' },
  dialog_result: { label: '对话框结果', icon: FileImage, color: '#3b82f6' },
  file_read: { label: '文件读取', icon: Eye, color: '#06b6d4' },
  file_convert: { label: '文件转换', icon: ArrowClockwise, color: '#8b5cf6' },
  upload_start: { label: '开始上传', icon: Upload, color: '#f59e0b' },
  upload_complete: { label: '上传完成', icon: CheckCircle, color: '#22c55e' },
  node_find: { label: '查找节点', icon: Code, color: '#6366f1' },
  node_update: { label: '更新节点', icon: Image, color: '#22c55e' },
  node_insert: { label: '插入节点', icon: Image, color: '#14b8a6' },
  image_render: { label: '图片渲染', icon: Image, color: '#0ea5e9' },
  dom_snapshot: { label: 'DOM快照', icon: Camera, color: '#06b6d4' },
  error: { label: '错误', icon: XCircle, color: '#ef4444' },
};
