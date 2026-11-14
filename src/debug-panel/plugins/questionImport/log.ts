/**
 * 题目导入调试：模块级日志收集器（上限 MAX_LOGS 条）与订阅者，以及供导入流程调用的发射函数。
 */

import type { ImportLogEntry, ImportLogLevel, ImportLogPhase } from './model';

// ============================================================================
// 常量
// ============================================================================

const MAX_LOGS = 3000;

// ============================================================================
// 全局日志收集器
// ============================================================================

let logIdCounter = 0;
const globalLogs: ImportLogEntry[] = [];
export const globalListeners = new Set<(entry: ImportLogEntry) => void>();

export function pushImportLog(
  level: ImportLogLevel,
  phase: ImportLogPhase,
  summary: string,
  opts?: Partial<Pick<ImportLogEntry, 'detail' | 'sessionId' | 'percent' | 'durationMs'>>,
): void {
  const entry: ImportLogEntry = {
    id: `qil-${++logIdCounter}`,
    ts: Date.now(),
    level,
    phase,
    summary,
    ...opts,
  };
  globalLogs.push(entry);
  if (globalLogs.length > MAX_LOGS) globalLogs.splice(0, globalLogs.length - MAX_LOGS);
  globalListeners.forEach((fn) => fn(entry));
}

export function snapshotLogs(): ImportLogEntry[] {
  return globalLogs.slice();
}

export function clearLogs(): void {
  globalLogs.length = 0;
  logIdCounter = 0;
}

/**
 * 便捷发射函数（供 ExamSheetUploader 等外部组件调用）
 */
export function emitImportDebug(
  level: ImportLogLevel,
  phase: ImportLogPhase,
  summary: string,
  opts?: Partial<Pick<ImportLogEntry, 'detail' | 'sessionId' | 'percent' | 'durationMs'>>,
): void {
  pushImportLog(level, phase, summary, opts);
}
