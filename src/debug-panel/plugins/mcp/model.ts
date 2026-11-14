/**
 * MCP 调试：日志级别与事件类型、日志条目结构，以及级别配色 / 图标、事件类型的中文标签与图标。
 */

import type React from 'react';
import { Warning, CheckCircle, XCircle, HardDrives, PaperPlaneRight, ArrowClockwise, Gear, Pulse, Database, Lightning } from '@phosphor-icons/react';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'success';
export type McpEventType = 
  | 'config_init'
  | 'config_change'
  | 'connect_start'
  | 'connect_success'
  | 'connect_fail'
  | 'connect_retry'
  | 'disconnect'
  | 'stdio_message_send'
  | 'stdio_message_recv'
  | 'stdio_error'
  | 'stdio_closed'
  | 'tool_call_start'
  | 'tool_call_success'
  | 'tool_call_error'
  | 'cache_hit'
  | 'cache_miss'
  | 'transport_error';

export interface McpLog {
  id: string;
  ts: number;
  serverId?: string;
  sessionId?: string;
  type: McpEventType;
  level: LogLevel;
  message: string;
  details?: {
    transport?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    payload?: string;
    error?: string;
    duration?: number;
    toolName?: string;
    toolArgs?: any;
    toolResult?: any;
    stackTrace?: string;
    [key: string]: any;
  };
}

export const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
};

export const LEVEL_ICONS: Record<LogLevel, React.FC<any>> = {
  debug: Pulse,
  info: HardDrives,
  success: CheckCircle,
  warning: Warning,
  error: XCircle,
};

export const EVENT_TYPE_LABELS: Record<McpEventType, string> = {
  config_init: '配置初始化',
  config_change: '配置变更',
  connect_start: '连接开始',
  connect_success: '连接成功',
  connect_fail: '连接失败',
  connect_retry: '重试连接',
  disconnect: '断开连接',
  stdio_message_send: 'Stdio发送',
  stdio_message_recv: 'Stdio接收',
  stdio_error: 'Stdio错误',
  stdio_closed: 'Stdio关闭',
  tool_call_start: '工具调用',
  tool_call_success: '工具成功',
  tool_call_error: '工具错误',
  cache_hit: '缓存命中',
  cache_miss: '缓存未命中',
  transport_error: '传输错误',
};

export const EVENT_TYPE_ICONS: Record<McpEventType, React.FC<any>> = {
  config_init: Gear,
  config_change: ArrowClockwise,
  connect_start: Pulse,
  connect_success: CheckCircle,
  connect_fail: XCircle,
  connect_retry: ArrowClockwise,
  disconnect: XCircle,
  stdio_message_send: PaperPlaneRight,
  stdio_message_recv: HardDrives,
  stdio_error: Warning,
  stdio_closed: XCircle,
  tool_call_start: Lightning,
  tool_call_success: CheckCircle,
  tool_call_error: XCircle,
  cache_hit: Database,
  cache_miss: Database,
  transport_error: Warning,
};
