/**
 * DSTU 调试插件
 * 
 * 监听所有 DSTU API 调用，包括 createEmpty、dstu.create 等
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Copy, Trash2, Filter, Download, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/shad/Button';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 类型定义
// ============================================================================

interface DstuLogEntry {
  id: number;
  timestamp: string;
  type: 'call' | 'success' | 'error';
  method: string;
  args?: unknown[];
  result?: unknown;
  error?: string;
  duration?: number;
}

export interface DstuDebugPluginProps {
  visible: boolean;
  isActive: boolean;
  isActivated: boolean;
  onClose: () => void;
}

// ============================================================================
// 全局日志收集器
// ============================================================================

let logIdCounter = 0;
const logBuffer: DstuLogEntry[] = [];
const MAX_LOGS = 500;
const listeners: Set<(logs: DstuLogEntry[]) => void> = new Set();

function addLog(entry: Omit<DstuLogEntry, 'id' | 'timestamp'>) {
  const log: DstuLogEntry = {
    ...entry,
    id: ++logIdCounter,
    timestamp: new Date().toISOString(),
  };
  
  logBuffer.unshift(log);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.pop();
  }
  
  // 通知所有监听器
  listeners.forEach(listener => listener([...logBuffer]));
}

// ============================================================================
// 控制台拦截器 - 捕获所有 [DSTU] 和 [LearningHub] 日志
// ============================================================================

let isConsoleHooked = false;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

function hookConsole() {
  if (isConsoleHooked) return;
  isConsoleHooked = true;

  const shouldCapture = (args: unknown[]) => {
    const first = args[0];
    if (typeof first !== 'string') return false;
    return first.includes('[DSTU') || first.includes('[LearningHub]') || first.includes('[useVfsFolders]');
  };

  console.log = (...args: unknown[]) => {
    originalConsoleLog.apply(console, args);
    if (shouldCapture(args)) {
      addLog({
        type: 'log' as any,
        method: 'console.log',
        args,
      });
    }
  };

  console.warn = (...args: unknown[]) => {
    originalConsoleWarn.apply(console, args);
    if (shouldCapture(args)) {
      addLog({
        type: 'warn' as any,
        method: 'console.warn',
        args,
      });
    }
  };

  console.error = (...args: unknown[]) => {
    originalConsoleError.apply(console, args);
    if (shouldCapture(args)) {
      addLog({
        type: 'error',
        method: 'console.error',
        error: args.map(a => String(a)).join(' '),
      });
    }
  };
}

// 自动 hook
hookConsole();

function clearLogs() {
  logBuffer.length = 0;
  listeners.forEach(listener => listener([]));
}

// ============================================================================
// 导出给 API 层使用的日志函数
// ============================================================================

export const dstuDebugLog = {
  call: (method: string, ...args: unknown[]) => {
    addLog({ type: 'call', method, args });
  },
  success: (method: string, result: unknown, duration?: number) => {
    addLog({ type: 'success', method, result, duration });
  },
  error: (method: string, error: string, args?: unknown[]) => {
    addLog({ type: 'error', method, error, args });
  },
};

// 挂载到 window 方便调试
if (typeof window !== 'undefined') {
  (window as any).__DSTU_DEBUG__ = {
    logs: logBuffer,
    clear: clearLogs,
    log: dstuDebugLog,
  };
}

// ============================================================================
// 插件组件
// ============================================================================

export const DstuDebugPlugin: React.FC<DstuDebugPluginProps> = ({
  visible,
  isActive,
  isActivated,
  onClose,
}) => {
  const [logs, setLogs] = useState<DstuLogEntry[]>([...logBuffer]);
  const [filter, setFilter] = useState<'all' | 'call' | 'success' | 'error'>('all');
  const [methodFilter, setMethodFilter] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 订阅日志更新
  useEffect(() => {
    const listener = (newLogs: DstuLogEntry[]) => {
      setLogs(newLogs);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // 过滤日志
  const filteredLogs = logs.filter(log => {
    if (filter !== 'all' && log.type !== filter) return false;
    if (methodFilter && !log.method.toLowerCase().includes(methodFilter.toLowerCase())) return false;
    return true;
  });

  // 复制单条日志
  const copyLog = useCallback((log: DstuLogEntry) => {
    const text = JSON.stringify(log, null, 2);
    copyTextToClipboard(text);
    setCopiedId(log.id);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  // 复制所有日志
  const copyAllLogs = useCallback(() => {
    const text = JSON.stringify(filteredLogs, null, 2);
    copyTextToClipboard(text);
  }, [filteredLogs]);

  // 导出日志
  const exportLogs = useCallback(() => {
    const text = JSON.stringify(filteredLogs, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dstu-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs]);

  if (!visible) return null;

  return (
    <div className="flex flex-col h-full bg-background text-foreground text-xs">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 p-2 border-b border-border bg-muted/50">
        <span className="font-semibold text-sm">DSTU Debug</span>
        
        {/* 类型过滤 */}
        <select
          value={filter}
          onChange={e => setFilter(e.target.value as any)}
          className="px-2 py-1 text-xs bg-background border border-border rounded"
        >
          <option value="all">全部</option>
          <option value="call">调用</option>
          <option value="success">成功</option>
          <option value="error">错误</option>
        </select>

        {/* 方法过滤 */}
        <input
          type="text"
          placeholder="过滤方法..."
          value={methodFilter}
          onChange={e => setMethodFilter(e.target.value)}
          className="px-2 py-1 text-xs bg-background border border-border rounded w-32"
        />

        <div className="flex-1" />

        <span className="text-muted-foreground">
          {filteredLogs.length}/{logs.length}
        </span>

        <Button variant="ghost" size="sm" onClick={copyAllLogs} title="复制全部">
          <Copy className="w-3.5 h-3.5" />
        </Button>
        <Button variant="ghost" size="sm" onClick={exportLogs} title="导出">
          <Download className="w-3.5 h-3.5" />
        </Button>
        <Button variant="ghost" size="sm" onClick={clearLogs} title="清空">
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* 日志列表 */}
      <div ref={listRef} className="flex-1 overflow-auto p-1">
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            暂无日志，等待 DSTU 调用...
          </div>
        ) : (
          filteredLogs.map(log => (
            <div
              key={log.id}
              className={cn(
                'p-2 mb-1 rounded border text-xs font-mono',
                log.type === 'error' && 'bg-red-500/10 border-red-500/30',
                log.type === 'success' && 'bg-green-500/10 border-green-500/30',
                log.type === 'call' && 'bg-blue-500/10 border-blue-500/30'
              )}
            >
              {/* 头部 */}
              <div className="flex items-center gap-2 mb-1">
                {log.type === 'error' && <XCircle className="w-3.5 h-3.5 text-red-500" />}
                {log.type === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                {log.type === 'call' && <Clock className="w-3.5 h-3.5 text-blue-500" />}
                
                <span className="font-semibold">{log.method}</span>
                <span className="text-muted-foreground text-[10px]">
                  {log.timestamp.slice(11, 23)}
                </span>
                {log.duration !== undefined && (
                  <span className="text-muted-foreground text-[10px]">
                    {log.duration}ms
                  </span>
                )}
                
                <div className="flex-1" />
                
                <button
                  onClick={() => copyLog(log)}
                  className="p-0.5 hover:bg-muted rounded"
                  title="复制"
                >
                  {copiedId === log.id ? (
                    <CheckCircle2 className="w-3 h-3 text-green-500" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>

              {/* 参数 */}
              {log.args && (
                <div className="mt-1">
                  <span className="text-muted-foreground">args: </span>
                  <pre className="inline whitespace-pre-wrap break-all">
                    {JSON.stringify(log.args, null, 2)}
                  </pre>
                </div>
              )}

              {/* 结果 */}
              {log.result !== undefined && (
                <div className="mt-1">
                  <span className="text-green-600 dark:text-green-400">result: </span>
                  <pre className="inline whitespace-pre-wrap break-all">
                    {JSON.stringify(log.result, null, 2)}
                  </pre>
                </div>
              )}

              {/* 错误 */}
              {log.error && (
                <div className="mt-1 text-red-600 dark:text-red-400">
                  <span>error: </span>
                  <span>{log.error}</span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default DstuDebugPlugin;
