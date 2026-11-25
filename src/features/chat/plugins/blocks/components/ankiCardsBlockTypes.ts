/**
 * Chat V2 - Anki 卡片块共享类型定义
 */

import type { AnkiCard, AnkiGenerationOptions } from '@/types';
import type { AnkiCriticSummary, AnkiGenerationStats } from './ankiCardsBlockState';

/**
 * Anki 卡片块警告信息（从后端事件传递）
 */
export interface AnkiCardsWarning {
  code: string;
  messageKey?: string;
  messageParams?: Record<string, unknown>;
  message?: string;
}

export interface AnkiCardsIssue {
  scope: string;
  code: string;
  severity: 'warning' | 'error';
  retryable: boolean;
  recovered: boolean;
  detail?: string;
}

/**
 * Anki 卡片块数据（从后端事件传递）
 */
export interface AnkiCardsBlockData {
  schemaVersion?: number;
  stateRevision?: number;
  /** 卡片列表 */
  cards: AnkiCard[];
  /** Agent 删除墓碑：阻止迟到/重放的生成结果复活已删除卡片。 */
  deletedCardIds?: string[];
  /** 后端 documentId（用于 status 查询/调试） */
  documentId?: string;
  /** 生成进度（后台流水线 patch 更新） */
  progress?: {
    stage?: string;
    message?: string;
    messageKey?: string;
    messageParams?: Record<string, unknown>;
    cardsGenerated?: number;
    completedRatio?: number;
    counts?: unknown;
    lastUpdatedAt?: string;
    route?: string;
  };
  /** AnkiConnect 可用性（后台流水线 patch 更新） */
  ankiConnect?: {
    available?: boolean | null;
    error?: string | null;
    checkedAt?: string;
  };
  /** 同步状态 */
  syncStatus?: 'pending' | 'syncing' | 'synced' | 'error';
  /** 同步错误 */
  syncError?: string;
  /** 模板 ID */
  templateId?: string;
  /** 多模板模式下模板 ID 列表 */
  templateIds?: string[];
  /** 模板选择模式：single / multiple / all */
  templateMode?: string;
  /** 生成选项 */
  options?: AnkiGenerationOptions;
  /** 关联的消息稳定 ID */
  messageStableId?: string;
  /** 业务会话 ID */
  businessSessionId?: string;
  /** 后端最终状态（用于 UI 显示） */
  finalStatus?: string;
  /** 后端错误信息（用于 UI 显示） */
  finalError?: string;
  workflowStatus?: 'running' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled';
  generationStatus?: 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';
  deliveryStatus?: 'empty' | 'incomplete' | 'ready';
  recoveryStatus?: 'none' | 'manual' | 'existing_cards' | 'retry';
  /** 生成失败时是否建议自动重试（onError 兜底写入） */
  shouldRetry?: boolean;
  availableCards?: number;
  recoveredCards?: number;
  issues?: AnkiCardsIssue[];
  /** 后端警告信息（用于 UI 显示） */
  warnings?: AnkiCardsWarning[];
  /**
   * APKG 媒体导入报告（`{declared, imported, skipped, skips: [{reason, count, filenames}], mediaDir}`）。
   * 弱类型透传自 tool_output，渲染前经 parseAnkiMediaReport 收紧。
   */
  mediaReport?: unknown;
  /**
   * 任务级 critic 摘要（anki_generation_event 的 CriticSummary 标签，
   * 适配器归一化后 patch 写入；仅 critic opt-in 且收尾成功时存在）。
   */
  criticSummary?: AnkiCriticSummary;
  /**
   * 流式生成质量统计（anki_generation_event 的 GenerationStats 标签，
   * 适配器归一化后 patch 写入）。
   */
  generationStats?: AnkiGenerationStats;
}

export interface DocumentTaskSummary {
  id?: unknown;
  status?: unknown;
}

/** 操作状态类型 */
export type ActionStatus = 'idle' | 'loading' | 'success' | 'error';

export type ZombieCompletionState =
  | {
      finalStatus: 'completed' | 'completed_with_errors';
      blockStatus: 'success';
    }
  | {
      finalStatus: 'error' | 'cancelled';
      blockStatus: 'error';
      errorKey:
        | 'blocks.ankiCards.errors.watchdogFailedWithoutCards'
        | 'blocks.ankiCards.errors.watchdogCancelledWithoutCards'
        | 'blocks.ankiCards.errors.watchdogCompletedWithoutCards'
        | 'blocks.ankiCards.errors.watchdogUnknownWithoutCards';
    };

export interface ZombieCardLike {
  is_error_card?: unknown;
  isErrorCard?: unknown;
}

export interface PendingDeleteEntry {
  card: AnkiCard;
  index: number;
}
