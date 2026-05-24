/**
 * SessionLoadFlowDebugPlugin - 会话加载流程调试插件
 * 
 * 追踪从分析库点击会话到聊天历史显示的完整数据流
 * 用于诊断会话加载时聊天历史不显示的问题
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { Separator } from '../../components/ui/shad/Separator';
import { Copy, Trash, Play, WarningCircle, CheckCircle, Warning, Database, ArrowClockwise } from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// =============================================================================
// 类型定义
// =============================================================================

interface LogEntry {
  id: string;
  timestamp: string;
  stage: 'app' | 'store' | 'sidebar' | 'host' | 'backend';
  action: string;
  data: Record<string, any>;
  severity: 'info' | 'warning' | 'error' | 'success';
}

interface StateSnapshot {
  timestamp: string;
  sessionId: string;
  storeState: {
    hasSession: boolean;
    sessionMessages: number;
    hasPersistedData: boolean;
    hasHistory: boolean;
    sourceType: string;
    lifecycle: string;
  } | null;
  hostState: {
    mode: string;
    isNewAnalysis: boolean;
    chatHistoryLength: number;
    landingVisible: boolean;
    inputDocked: boolean;
    preloadedChatHistoryLength: number;
  } | null;
}

// =============================================================================
// 全局日志收集器
// =============================================================================

const SESSION_LOAD_LOGS: LogEntry[] = [];
const STATE_SNAPSHOTS: StateSnapshot[] = [];
let LOG_ID_COUNTER = 0;

// 全局日志函数
export function logSessionLoadFlow(
  stage: LogEntry['stage'],
  action: string,
  data: Record<string, any>,
  severity: LogEntry['severity'] = 'info'
) {
  const entry: LogEntry = {
    id: `log-${++LOG_ID_COUNTER}`,
    timestamp: new Date().toISOString(),
    stage,
    action,
    data,
    severity,
  };
  SESSION_LOAD_LOGS.push(entry);
  
  // 控制台输出
  const prefix = `[SessionLoad][${stage}]`;
  const consoleData = { action, ...data };
  switch (severity) {
    case 'error':
      console.error(prefix, consoleData);
      break;
    case 'warning':
      console.warn(prefix, consoleData);
      break;
    case 'success':
      console.log(`✅ ${prefix}`, consoleData);
      break;
    default:
      console.log(prefix, consoleData);
  }
  
  // 触发事件通知 UI 更新
  window.dispatchEvent(new CustomEvent('SESSION_LOAD_LOG_ADDED', { detail: entry }));
}

export function captureStateSnapshot(snapshot: StateSnapshot) {
  STATE_SNAPSHOTS.push(snapshot);
  window.dispatchEvent(new CustomEvent('SESSION_STATE_SNAPSHOT', { detail: snapshot }));
}

export function clearSessionLoadLogs() {
  SESSION_LOAD_LOGS.length = 0;
  STATE_SNAPSHOTS.length = 0;
  LOG_ID_COUNTER = 0;
}

// =============================================================================
// 注入日志收集代码到各个模块
// =============================================================================

function injectLoggers() {
  // 暴露全局函数供其他模块调用
  (window as any).__sessionLoadDebug = {
    log: logSessionLoadFlow,
    snapshot: captureStateSnapshot,
    clear: clearSessionLoadLogs,
    getLogs: () => [...SESSION_LOAD_LOGS],
    getSnapshots: () => [...STATE_SNAPSHOTS],
  };
}

// =============================================================================
// 组件
// =============================================================================

const SessionLoadFlowDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [snapshots, setSnapshots] = useState<StateSnapshot[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // 初始化
  useEffect(() => {
    injectLoggers();
  }, []);

  // 监听日志事件
  useEffect(() => {
    if (!isActive) return;

    const handleLogAdded = (e: Event) => {
      const entry = (e as CustomEvent<LogEntry>).detail;
      setLogs(prev => [...prev, entry]);
    };

    const handleSnapshot = (e: Event) => {
      const snapshot = (e as CustomEvent<StateSnapshot>).detail;
      setSnapshots(prev => [...prev, snapshot]);
    };

    // 初始加载已有日志
    setLogs([...SESSION_LOAD_LOGS]);
    setSnapshots([...STATE_SNAPSHOTS]);

    window.addEventListener('SESSION_LOAD_LOG_ADDED', handleLogAdded);
    window.addEventListener('SESSION_STATE_SNAPSHOT', handleSnapshot);

    return () => {
      window.removeEventListener('SESSION_LOAD_LOG_ADDED', handleLogAdded);
      window.removeEventListener('SESSION_STATE_SNAPSHOT', handleSnapshot);
    };
  }, [isActive]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const handleClear = useCallback(() => {
    clearSessionLoadLogs();
    setLogs([]);
    setSnapshots([]);
  }, []);

  const handleCopyLogs = useCallback(() => {
    const report = {
      generatedAt: new Date().toISOString(),
      logsCount: logs.length,
      snapshotsCount: snapshots.length,
      logs: logs.map(l => ({
        ...l,
        data: JSON.parse(JSON.stringify(l.data)),
      })),
      snapshots,
      summary: {
        stages: {
          app: logs.filter(l => l.stage === 'app').length,
          store: logs.filter(l => l.stage === 'store').length,
          sidebar: logs.filter(l => l.stage === 'sidebar').length,
          host: logs.filter(l => l.stage === 'host').length,
          backend: logs.filter(l => l.stage === 'backend').length,
        },
        severities: {
          error: logs.filter(l => l.severity === 'error').length,
          warning: logs.filter(l => l.severity === 'warning').length,
          success: logs.filter(l => l.severity === 'success').length,
          info: logs.filter(l => l.severity === 'info').length,
        },
      },
    };

    copyTextToClipboard(JSON.stringify(report, null, 2));
    console.log('📋 会话加载日志已复制到剪贴板');
  }, [logs, snapshots]);

  const handleManualCapture = useCallback(() => {
    // 手动触发状态捕获
    window.dispatchEvent(new CustomEvent('SESSION_LOAD_MANUAL_CAPTURE'));
  }, []);

  if (!visible || !isActive) return null;

  const getSeverityIcon = (severity: LogEntry['severity']) => {
    switch (severity) {
      case 'error':
        return <WarningCircle size={16} className="text-red-500" />;
      case 'warning':
        return <Warning size={16} className="text-yellow-500" />;
      case 'success':
        return <CheckCircle size={16} className="text-green-500" />;
      default:
        return <Database size={16} className="text-blue-500" />;
    }
  };

  const getStageBadgeColor = (stage: LogEntry['stage']) => {
    switch (stage) {
      case 'app':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'store':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'sidebar':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'host':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      case 'backend':
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200';
    }
  };

  return (
    <div className="flex flex-col h-full p-4 space-y-4 overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">会话加载流程追踪</h3>
          <Badge variant="outline">{logs.length} 条日志</Badge>
          <Badge variant="outline">{snapshots.length} 个快照</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleManualCapture}>
            <ArrowClockwise size={16} className="mr-1" />
            捕获状态
          </Button>
          <Button size="sm" variant="outline" onClick={handleCopyLogs}>
            <Copy size={16} className="mr-1" />
            复制全部
          </Button>
          <Button size="sm" variant="destructive" onClick={handleClear}>
            <Trash size={16} className="mr-1" />
            清空
          </Button>
        </div>
      </div>

      <Separator />

      {/* 使用说明 */}
      <Card className="flex-shrink-0">
        <CardHeader className="py-2">
          <CardTitle className="text-sm">使用说明</CardTitle>
        </CardHeader>
        <CardContent className="py-2 text-xs text-muted-foreground">
          <ol className="list-decimal list-inside space-y-1">
            <li>点击"清空"清除旧日志</li>
            <li>从分析库列表点击一个会话</li>
            <li>观察日志流转，查找问题节点</li>
            <li>点击"复制全部"获取完整报告</li>
          </ol>
        </CardContent>
      </Card>

      {/* 日志列表 */}
      <div className="flex-1 overflow-auto border rounded-md p-2 space-y-2 bg-muted/30">
        {logs.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            <Database size={48} className="mx-auto mb-2 opacity-50" />
            <p>暂无日志</p>
            <p className="text-xs">从分析库点击会话开始追踪</p>
          </div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className="flex items-start gap-2 p-2 bg-background rounded border text-xs"
            >
              {getSeverityIcon(log.severity)}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Badge className={`text-[10px] px-1.5 py-0 ${getStageBadgeColor(log.stage)}`}>
                    {log.stage}
                  </Badge>
                  <span className="font-medium">{log.action}</span>
                  <span className="text-muted-foreground text-[10px]">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(log.data, null, 2)}
                </pre>
              </div>
            </div>
          ))
        )}
        <div ref={logsEndRef} />
      </div>

      {/* 最新快照 */}
      {snapshots.length > 0 && (
        <>
          <Separator />
          <Card className="flex-shrink-0">
            <CardHeader className="py-2">
              <CardTitle className="text-sm">最新状态快照</CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              <pre className="text-[10px] overflow-x-auto bg-muted p-2 rounded">
                {JSON.stringify(snapshots[snapshots.length - 1], null, 2)}
              </pre>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
};

export default SessionLoadFlowDebugPlugin;
