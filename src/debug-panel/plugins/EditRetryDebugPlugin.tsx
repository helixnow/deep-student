import { copyTextToClipboard } from '@/utils/clipboardUtils';

/**
 * EditRetryDebugPlugin - 编辑重发与重试流程调试插件
 *
 * 追踪以下两个问题的完整数据流：
 * 1. 编辑并重发没有任何反应
 * 2. 重试时UI未清空后续消息
 *
 * 监听关键节点：
 * - UI层：handleEdit、handleConfirmEdit 触发
 * - Store层：editAndResend、retryMessage 执行
 * - 状态变化：canEdit、isLocked、activeBlockIds、messageOrder
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { Separator } from '../../components/ui/shad/Separator';
import {
  Copy,
  Trash,
  WarningCircle,
  CheckCircle,
  Warning,
  PencilSimple,
  ArrowClockwise,
  Lock,
  LockOpen,
  ArrowRight,
  Funnel,
  Eye,
  EyeSlash,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  getChatV2Logs,
  clearChatV2Logs,
  CHATV2_LOG_EVENT,
  CHATV2_LOGS_CLEARED,
  type ChatV2LogEntry,
} from '../../features/chat/debug/chatV2Logger';

// =============================================================================
// 类型定义
// =============================================================================

type FlowType = 'edit' | 'retry' | 'all';

interface FlowStep {
  id: string;
  timestamp: string;
  step: string;
  stage: string;
  status: 'success' | 'warning' | 'error' | 'info';
  data: Record<string, unknown>;
  messageId?: string;
}

// =============================================================================
// 常量
// =============================================================================

// 编辑流程关键动作
const EDIT_ACTIONS = [
  'handleEdit_called',
  'handleEdit_blocked',
  'handleEdit_started',
  'handleConfirmEdit_called',
  'handleConfirmEdit_content_unchanged',
  'handleConfirmEdit_empty_content',
  'handleConfirmEdit_submitted',
  'editAndResend_called',
  'editAndResend_canEdit_check',
  'editAndResend_operation_locked',
  'editAndResend_callback_missing',
  'editAndResend_deleting_messages',
  'editAndResend_updating_content',
  'editAndResend_streaming_started',
  'editAndResend_completed',
  'editAndResend_failed',
  'editAndResend_rollback',
];

// 重试流程关键动作
const RETRY_ACTIONS = [
  'handleRetry_called',
  'handleRetry_blocked',
  'retryMessage_called',
  'retryMessage_canEdit_check',
  'retryMessage_operation_locked',
  'retryMessage_callback_missing',
  'retryMessage_deleting_subsequent', // 🔧 已修复：现在会实际删除后续消息
  'retryMessage_clearing_blocks',
  'retryMessage_streaming_started',
  'retryMessage_completed',
  'retryMessage_failed',
];

// 状态监控动作
const STATE_ACTIONS = [
  'canEdit_computed',
  'isLocked_computed',
  'activeBlockIds_changed',
  'messageOrder_changed',
  'sessionStatus_changed',
  'messageOperationLock_changed',
];

// 所有相关动作
const ALL_RELEVANT_ACTIONS = [...EDIT_ACTIONS, ...RETRY_ACTIONS, ...STATE_ACTIONS];

// =============================================================================
// 工具函数
// =============================================================================

function isRelevantLog(log: ChatV2LogEntry): boolean {
  return ALL_RELEVANT_ACTIONS.some(action => log.action.includes(action));
}

function getFlowType(action: string): FlowType {
  if (EDIT_ACTIONS.some(a => action.includes(a))) return 'edit';
  if (RETRY_ACTIONS.some(a => action.includes(a))) return 'retry';
  return 'all';
}

function getSeverityIcon(severity: string) {
  switch (severity) {
    case 'error':
      return <WarningCircle size={16} className="text-destructive" />;
    case 'warning':
      return <Warning size={16} className="text-yellow-500" />;
    case 'success':
      return <CheckCircle size={16} className="text-green-500" />;
    default:
      return <ArrowRight size={16} className="text-muted-foreground" />;
  }
}

function getStageColor(stage: string): string {
  switch (stage) {
    case 'ui':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
    case 'hook':
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
    case 'store':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
    case 'adapter':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
    case 'middleware':
      return 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

// =============================================================================
// 组件
// =============================================================================

const EditRetryDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
}) => {
  const [logs, setLogs] = useState<ChatV2LogEntry[]>([]);
  const [flowFilter, setFlowFilter] = useState<FlowType>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showStateChanges, setShowStateChanges] = useState(true);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const logsEndRef = useRef<HTMLDivElement>(null);

  // 过滤日志
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      if (!isRelevantLog(log)) return false;

      const logFlowType = getFlowType(log.action);

      // 状态变化日志的特殊处理
      if (STATE_ACTIONS.some(a => log.action.includes(a))) {
        if (!showStateChanges) return false;
        // 状态变化在所有过滤器下都显示
        return true;
      }

      if (flowFilter === 'all') return true;
      return logFlowType === flowFilter;
    });
  }, [logs, flowFilter, showStateChanges]);

  // 统计信息
  const stats = useMemo(() => {
    const editLogs = logs.filter(l => EDIT_ACTIONS.some(a => l.action.includes(a)));
    const retryLogs = logs.filter(l => RETRY_ACTIONS.some(a => l.action.includes(a)));
    const errorLogs = logs.filter(l => l.severity === 'error');
    const warningLogs = logs.filter(l => l.severity === 'warning');

    return {
      total: logs.filter(isRelevantLog).length,
      edit: editLogs.length,
      retry: retryLogs.length,
      errors: errorLogs.length,
      warnings: warningLogs.length,
    };
  }, [logs]);

  // 监听日志事件
  useEffect(() => {
    if (!isActive) return;

    // 加载现有日志
    setLogs(getChatV2Logs());

    const handleLogAdded = (e: Event) => {
      const entry = (e as CustomEvent<ChatV2LogEntry>).detail;
      setLogs(prev => [...prev, entry]);
    };

    const handleLogsCleared = () => {
      setLogs([]);
    };

    window.addEventListener(CHATV2_LOG_EVENT, handleLogAdded);
    window.addEventListener(CHATV2_LOGS_CLEARED, handleLogsCleared);

    return () => {
      window.removeEventListener(CHATV2_LOG_EVENT, handleLogAdded);
      window.removeEventListener(CHATV2_LOGS_CLEARED, handleLogsCleared);
    };
  }, [isActive]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs, autoScroll]);

  // 复制日志
  const handleCopyLogs = useCallback(() => {
    const text = filteredLogs
      .map(l => `[${l.timestamp}] [${l.stage}] ${l.action}: ${JSON.stringify(l.data)}`)
      .join('\n');
    copyTextToClipboard(text);
  }, [filteredLogs]);

  // 清空日志
  const handleClearLogs = useCallback(() => {
    clearChatV2Logs();
  }, []);

  // 切换日志展开
  const toggleLogExpand = useCallback((logId: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  }, []);

  if (!visible) return null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 头部统计 */}
      <Card className="m-2 flex-shrink-0">
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <PencilSimple size={16} />
            编辑/重试流程调试
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2 px-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">
              总计: {stats.total}
            </Badge>
            <Badge variant="outline" className="bg-blue-50 dark:bg-blue-950">
              <PencilSimple size={12} className="mr-1" />
              编辑: {stats.edit}
            </Badge>
            <Badge variant="outline" className="bg-green-50 dark:bg-green-950">
              <ArrowClockwise size={12} className="mr-1" />
              重试: {stats.retry}
            </Badge>
            {stats.errors > 0 && (
              <Badge variant="destructive">
                错误: {stats.errors}
              </Badge>
            )}
            {stats.warnings > 0 && (
              <Badge className="bg-yellow-500">
                警告: {stats.warnings}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 过滤器和操作 */}
      <div className="px-2 py-1 flex flex-wrap items-center gap-2 border-b flex-shrink-0">
        <div className="flex items-center gap-1">
          <Funnel size={12} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground">过滤:</span>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={flowFilter === 'all' ? 'default' : 'outline'}
            onClick={() => setFlowFilter('all')}
            className="h-6 text-xs px-2"
          >
            全部
          </Button>
          <Button
            size="sm"
            variant={flowFilter === 'edit' ? 'default' : 'outline'}
            onClick={() => setFlowFilter('edit')}
            className="h-6 text-xs px-2"
          >
            <PencilSimple size={12} className="mr-1" />
            编辑
          </Button>
          <Button
            size="sm"
            variant={flowFilter === 'retry' ? 'default' : 'outline'}
            onClick={() => setFlowFilter('retry')}
            className="h-6 text-xs px-2"
          >
            <ArrowClockwise size={12} className="mr-1" />
            重试
          </Button>
        </div>

        <Separator className="h-4 w-px" />

        <Button
          size="sm"
          variant={showStateChanges ? 'default' : 'outline'}
          onClick={() => setShowStateChanges(!showStateChanges)}
          className="h-6 text-xs px-2"
        >
          {showStateChanges ? <Eye size={12} className="mr-1" /> : <EyeSlash size={12} className="mr-1" />}
          状态
        </Button>

        <div className="flex-1" />

        <Button
          size="sm"
          variant="outline"
          onClick={() => setAutoScroll(!autoScroll)}
          className="h-6 text-xs px-2"
        >
          {autoScroll ? <Lock size={12} className="mr-1" /> : <LockOpen size={12} className="mr-1" />}
          {autoScroll ? '锁定' : '解锁'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopyLogs}
          className="h-6 text-xs px-2"
        >
          <Copy size={12} />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleClearLogs}
          className="h-6 text-xs px-2"
        >
          <Trash size={12} />
        </Button>
      </div>

      {/* 日志列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredLogs.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-8">
            <PencilSimple size={32} className="mx-auto mb-2 opacity-50" />
            <p>暂无编辑/重试相关日志</p>
            <p className="text-xs mt-1">尝试编辑消息或重试以触发日志</p>
          </div>
        ) : (
          filteredLogs.map((log) => {
            const isExpanded = expandedLogs.has(log.id);
            const flowType = getFlowType(log.action);
            const isStateLog = STATE_ACTIONS.some(a => log.action.includes(a));

            return (
              <div
                key={log.id}
                className={`
                  rounded border p-2 text-xs cursor-pointer transition-colors
                  ${log.severity === 'error' ? 'border-destructive bg-destructive/5' : ''}
                  ${log.severity === 'warning' ? 'border-yellow-500 bg-yellow-500/5' : ''}
                  ${log.severity === 'success' ? 'border-green-500 bg-green-500/5' : ''}
                  ${isStateLog ? 'border-dashed opacity-75' : ''}
                  hover:bg-muted/50
                `}
                onClick={() => toggleLogExpand(log.id)}
              >
                {/* 头部 */}
                <div className="flex items-center gap-2">
                  {getSeverityIcon(log.severity)}

                  <span className="text-muted-foreground font-mono">
                    {formatTimestamp(log.timestamp)}
                  </span>

                  <Badge className={`text-[10px] px-1 py-0 ${getStageColor(log.stage)}`}>
                    {log.stage}
                  </Badge>

                  {flowType === 'edit' && (
                    <PencilSimple size={12} className="text-blue-500" />
                  )}
                  {flowType === 'retry' && (
                    <ArrowClockwise size={12} className="text-green-500" />
                  )}

                  <span className="font-medium truncate flex-1">
                    {log.action}
                  </span>

                  {log.messageId && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      {log.messageId.slice(0, 8)}...
                    </Badge>
                  )}
                </div>

                {/* 关键数据预览 */}
                {!isExpanded && Object.keys(log.data).length > 0 && (
                  <div className="mt-1 text-muted-foreground truncate pl-6">
                    {Object.entries(log.data).slice(0, 3).map(([k, v]) => (
                      <span key={k} className="mr-2">
                        <span className="text-muted-foreground/70">{k}:</span>
                        <span className="ml-1">
                          {typeof v === 'boolean' ? (v ? '✓' : '✗') : String(v).slice(0, 20)}
                        </span>
                      </span>
                    ))}
                    {Object.keys(log.data).length > 3 && <span>...</span>}
                  </div>
                )}

                {/* 展开详情 */}
                {isExpanded && (
                  <div className="mt-2 pl-6">
                    <pre className="text-[10px] bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(log.data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={logsEndRef} />
      </div>

      {/* 问题诊断提示 */}
      {stats.errors > 0 && (
        <Card className="m-2 border-destructive flex-shrink-0">
          <CardContent className="py-2 px-3">
            <div className="flex items-start gap-2 text-xs">
              <WarningCircle size={16} className="text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">检测到错误</p>
                <p className="text-muted-foreground mt-1">
                  请检查上方红色标记的日志条目，可能是导致问题的根因。
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default EditRetryDebugPlugin;
