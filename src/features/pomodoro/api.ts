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
