/**
 * 多 Agent 调试日志：模块级存储（最多 500 条），面板经 panelFeed 订阅新增与清空；同时挂到 window.__multiAgentDebug。
 */

import { debugLog } from '../../debugMasterSwitch';
import { createPanelFeed } from '../../panelFeed';

// =============================================================================
// 类型定义
// =============================================================================

export interface MultiAgentLogEntry {
  id: string;
  timestamp: string;
  type: 'workspace' | 'agent' | 'message' | 'error' | 'system' | 'block';
  action: string;
  data: Record<string, unknown>;
  severity: 'info' | 'success' | 'warning' | 'error';
}

// =============================================================================
// 日志存储
// =============================================================================

const MAX_LOGS = 500;
let multiAgentLogs: MultiAgentLogEntry[] = [];
export const logAdded = createPanelFeed<MultiAgentLogEntry>();
export const logsCleared = createPanelFeed();

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function logMultiAgent(
  type: MultiAgentLogEntry['type'],
  action: string,
  data: Record<string, unknown>,
  severity: MultiAgentLogEntry['severity'] = 'info'
): void {
  const entry: MultiAgentLogEntry = {
    id: `ma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type,
    action,
    data,
    severity,
  };

  multiAgentLogs.push(entry);
  if (multiAgentLogs.length > MAX_LOGS) {
    multiAgentLogs = multiAgentLogs.slice(-MAX_LOGS);
  }

  // 通知面板
  logAdded.publish(entry);

  // 控制台输出
  const prefix = `[MultiAgent:${type}]`;
  const logFn = severity === 'error' ? console.error : severity === 'warning' ? console.warn : console.log;
  logFn(prefix, action, data);
}

export function clearMultiAgentLogs(): void {
  multiAgentLogs = [];
  logsCleared.publish();
}

export function getMultiAgentLogs(): MultiAgentLogEntry[] {
  return [...multiAgentLogs];
}

// 全局注入
(window as any).__multiAgentDebug = {
  log: logMultiAgent,
  clear: clearMultiAgentLogs,
  getLogs: getMultiAgentLogs,
};
