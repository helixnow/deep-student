/**
 * 番茄钟 Tauri API 层
 */

import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// Types
// ============================================================================

export interface PomodoroRecord {
  id: string;
  todoItemId?: string;
  startTime: string;
  endTime?: string;
  duration: number;
  actualDuration: number;
  type: 'work' | 'short_break' | 'long_break';
  status: 'completed' | 'interrupted';
  createdAt: string;
}

export interface CreatePomodoroInput {
  todoItemId?: string;
  startTime: string;
  endTime?: string;
  duration: number;
  actualDuration: number;
  type?: 'work' | 'short_break' | 'long_break';
  status?: 'completed' | 'interrupted';
}

export interface PomodoroTodayStats {
  completedCount: number;
  totalFocusSeconds: number;
  interruptedCount: number;
}

/** 单日聚合统计（本地日期分桶，趋势/热力图数据源） */
export interface PomodoroDailyStat {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  completedCount: number;
  focusSeconds: number;
  interruptedCount: number;
}

// ============================================================================
// Pomodoro API
// ============================================================================

export async function createPomodoroRecord(input: CreatePomodoroInput): Promise<PomodoroRecord> {
  return invoke('pomodoro_create_record', { input });
}

export async function getPomodoroRecord(recordId: string): Promise<PomodoroRecord | null> {
  return invoke('pomodoro_get_record', { recordId });
}

export async function listPomodorosByTodo(todoItemId: string): Promise<PomodoroRecord[]> {
  return invoke('pomodoro_list_by_todo', { todoItemId });
}

export async function getPomodoroTodayStats(): Promise<PomodoroTodayStats> {
  return invoke('pomodoro_today_stats');
}

export async function listTodayPomodoros(): Promise<PomodoroRecord[]> {
  return invoke('pomodoro_list_today');
}

/** 近 N 天按本地日期聚合的番茄统计（完整日期序列，无记录天补零） */
export async function getPomodoroDailyStats(days: number): Promise<PomodoroDailyStat[]> {
  return invoke('pomodoro_daily_stats', { days });
}

/** 删除单条番茄记录 */
export async function deletePomodoroRecord(recordId: string): Promise<void> {
  return invoke('pomodoro_delete_record', { recordId });
}

/** 按本地日期区间（YYYY-MM-DD，含两端）列出番茄记录 */
export async function listPomodorosInRange(
  startDate: string,
  endDate: string,
): Promise<PomodoroRecord[]> {
  return invoke('pomodoro_list_range', { startDate, endDate });
}
