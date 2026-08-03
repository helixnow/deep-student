/**
 * CardForge - 任务状态规范化工具
 *
 * 背景：后端 `TaskStatus`（src-tauri/src/models.rs）序列化为帕斯卡命名
 * （"Pending" / "Processing" / "Failed" / "Truncated" ...），而前端类型
 * `TaskStatus` 使用小写。历史上各调用方各自比较 'failed' 或 'Failed'，
 * 大小写不一致导致判断遗漏。
 *
 * 本模块提供大小写不敏感的统一归一化入口，供 cardforge 内部
 * 及外部调用方（ankiCardsBlock / anki-tasks 等）共同使用。
 */

import type { TaskStatus } from '../types';

/** 全部合法的前端任务状态（小写规范形态） */
export const ALL_TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'processing',
  'streaming',
  'paused',
  'completed',
  'failed',
  'truncated',
  'cancelled',
] as const;

/** 失败口径状态（与会话统计 failed_tasks 一致：Failed / Truncated / Cancelled） */
export const FAILED_LIKE_TASK_STATUSES: readonly TaskStatus[] = [
  'failed',
  'truncated',
  'cancelled',
] as const;

/** 终态：不会再产生新事件的状态 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'completed',
  'failed',
  'truncated',
  'cancelled',
] as const;

/** 活跃态：任务仍在推进（含待调度） */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'processing',
  'streaming',
] as const;

const STATUS_LOOKUP: ReadonlyMap<string, TaskStatus> = new Map(
  ALL_TASK_STATUSES.map((status) => [status, status]),
);

/**
 * 将任意来源的任务状态归一化为前端小写 `TaskStatus`。
 *
 * - 大小写不敏感（'Failed' / 'FAILED' / 'failed' 均归一为 'failed'）
 * - 自动去除首尾空白
 * - 无法识别的输入回退到 `fallback`（默认 'pending'）
 */
export function normalizeTaskStatus(
  status: unknown,
  fallback: TaskStatus = 'pending',
): TaskStatus {
  if (typeof status !== 'string') {
    return fallback;
  }
  return STATUS_LOOKUP.get(status.trim().toLowerCase()) ?? fallback;
}

/** 大小写不敏感地比较两个状态是否等价 */
export function taskStatusEquals(a: unknown, b: unknown): boolean {
  return normalizeTaskStatus(a) === normalizeTaskStatus(b);
}

/** 是否属于失败口径（failed / truncated / cancelled），大小写不敏感 */
export function isFailedLikeTaskStatus(status: unknown): boolean {
  const normalized = normalizeTaskStatus(status);
  return FAILED_LIKE_TASK_STATUSES.includes(normalized);
}

/** 是否为终态（completed / failed / truncated / cancelled），大小写不敏感 */
export function isTerminalTaskStatus(status: unknown): boolean {
  const normalized = normalizeTaskStatus(status);
  return TERMINAL_TASK_STATUSES.includes(normalized);
}

/** 是否为活跃态（pending / processing / streaming），大小写不敏感 */
export function isActiveTaskStatus(status: unknown): boolean {
  const normalized = normalizeTaskStatus(status);
  return ACTIVE_TASK_STATUSES.includes(normalized);
}
