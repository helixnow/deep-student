/**
 * 媒体预处理调试：事件结构、阶段的中文标签与配色、事件类型图标、事件上限，以及时间戳格式化与事件 ID。
 */

import type React from 'react';
import { CheckCircle, XCircle, CircleNotch, Trash, Cursor, PaperPlaneRight } from '@phosphor-icons/react';
import type { MediaType } from '@/features/pdf/stores/pdfProcessingStore';

// =============================================================================
// 类型定义
// =============================================================================

export interface MediaProcessingEvent {
  id: string;
  timestamp: string;
  eventType: 'progress' | 'completed' | 'error' | 'mode_change' | 'inject' | 'lifecycle';
  fileId: string;
  mediaType: MediaType;
  stage?: string;
  percent?: number;
  readyModes?: string[];
  error?: string;
  currentPage?: number;
  totalPages?: number;
  source: 'media' | 'pdf' | 'ui' | 'adapter'; // 事件来源
  // 注入模式变化专用字段
  modesBefore?: string[];
  modesAfter?: string[];
  toggledMode?: string;
  // 实际注入内容专用字段
  injectedContent?: {
    textBlocks: number;
    imageBlocks: number;
    totalTextLength: number;
    hasMultimodal: boolean;
  };
  injectModes?: Record<string, string[]>;
}

// =============================================================================
// 常量
// =============================================================================

export const STAGE_LABELS: Record<string, string> = {
  pending: '等待中',
  text_extraction: '文本提取',
  page_rendering: '页面渲染',
  page_compression: '页面压缩',
  image_compression: '图片压缩',
  ocr_processing: 'OCR 处理',
  vector_indexing: '向量索引',
  completed: '已完成',
  error: '错误',
  removed: '已移除',
  store_cleanup: 'Store 清理',
};

export const STAGE_COLORS: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  text_extraction: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  page_rendering: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200',
  page_compression: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  image_compression: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  ocr_processing: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  vector_indexing: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  error: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

export const EVENT_TYPE_ICONS: Record<string, React.ReactNode> = {
  progress: <CircleNotch size={12} className="text-blue-500 animate-spin" />,
  completed: <CheckCircle size={12} className="text-green-500" />,
  error: <XCircle size={12} className="text-red-500" />,
  mode_change: <Cursor size={12} className="text-purple-500" />,
  inject: <PaperPlaneRight size={12} className="text-teal-500" />,
  lifecycle: <Trash size={12} className="text-gray-500" />,
};

export const MAX_EVENTS = 200;

// =============================================================================
// 辅助函数
// =============================================================================

export function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${time}.${ms}`;
}

export function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}
