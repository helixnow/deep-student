/**
 * Anki 模块类型定义
 *
 * 集中管理 Anki 制卡模块的类型定义
 */

import type { AnkiCard, AnkiCardTemplate, AnkiGenerationOptions } from '@/types';

// Re-export from main types
export type { AnkiCard, AnkiCardTemplate, AnkiGenerationOptions };

/**
 * 文档任务 UI 状态
 */
export interface DocumentTaskUI {
  task_id: string;
  segment_index: number;
  status: 'pending' | 'processing' | 'streaming' | 'completed' | 'failed' | 'paused';
  error_message?: string | null;
  progress?: number;
  cards: AnkiCard[];
  template_id?: string | null;
}

/**
 * Anki 流事件载荷类型
 */
export interface AnkiStreamEventPayload {
  type:
    | 'DocumentProcessingStarted'
    | 'TaskStatusUpdate'
    | 'CardStreaming'
    | 'TaskCompleted'
    | 'GenerationCompleted'
    | 'GenerationPaused'
    | 'GenerationCancelled'
    | 'GenerationError';
  data: Record<string, unknown>;
}

/**
 * 文档处理开始事件数据
 */
export interface DocumentProcessingStartedData {
  document_id: string;
  total_segments: number;
}

/**
 * 任务状态更新事件数据
 */
export interface TaskStatusUpdateData {
  task_id?: string;
  segment_index?: number;
  status: string;
  message?: string;
  progress?: number;
}

/**
 * 卡片流事件数据
 */
export interface CardStreamingData {
  task_id?: string;
  segment_index?: number;
  card: AnkiCard;
}

/**
 * 任务完成事件数据
 */
export interface TaskCompletedData {
  task_id: string;
  final_status: string;
  total_cards_generated?: number;
  cards?: AnkiCard[];
}

/**
 * 生成完成事件数据
 */
export interface GenerationCompletedData {
  document_id: string;
  total_cards?: number;
  stats?: {
    total: number;
    success: number;
    failed: number;
    duration_ms: number;
  };
}

/**
 * 导出级别
 * - document: 导出整个文档的所有卡片
 * - task: 导出当前任务的卡片
 * - selection: 导出选中的卡片
 */
export type ExportLevel = 'document' | 'task' | 'selection';

/**
 * 导出格式
 */
export type ExportFormat = 'apkg' | 'anki_connect' | 'json';

/**
 * 导出选项
 */
export interface ExportOptions {
  level: ExportLevel;
  format: ExportFormat;
  deckName: string;
  noteType?: string;
  cards?: AnkiCard[];
}

/**
 * AnkiConnect 状态
 */
export interface AnkiConnectStatus {
  isAvailable: boolean;
  deckNames: string[];
  modelNames: string[];
  error?: string;
}

/**
 * 生成参数配置
 */
export interface GenerationConfig {
  deckName: string;
  noteType: string;
  templateId?: string;
  maxCards?: number;
  customRequirements?: string;
  systemPrompt?: string;
}
