/**
 * MultiVariantDebugPlugin - 多变体并行执行调试插件
 * 
 * 追踪从 @模型 选择到后端并行执行的完整数据流
 * 用于诊断多变体模式不触发的问题
 * 
 * 🔧 已集成到 Chat V2 统一调试系统
 * @see src/chat-v2/debug/chatV2Logger.ts
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { Separator } from '../../components/ui/shad/Separator';
import { Copy, Trash, WarningCircle, CheckCircle, Warning, Stack, ArrowRight, Bug } from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import {
  logChatV2,
  clearChatV2Logs,
  getChatV2Logs,
  getChatV2LogStats,
  CHATV2_LOG_EVENT,
  CHATV2_LOGS_CLEARED,
  type ChatV2LogEntry,
  type ChatV2LogCategory,
  type ChatV2LogStage,
} from '../../features/chat/debug/chatV2Logger';

// =============================================================================
// 类型定义（兼容旧接口）
// =============================================================================

type LegacyStage = 'chip' | 'hook' | 'store' | 'adapter' | 'backend';
type LegacySeverity = 'info' | 'warning' | 'error' | 'success';

interface LogEntry {
  id: string;
  timestamp: string;
  stage: LegacyStage;
  action: string;
  data: Record<string, unknown>;
  severity: LegacySeverity;
}

// =============================================================================
// 阶段映射
// =============================================================================

const STAGE_MAP: Record<LegacyStage, ChatV2LogStage> = {
  chip: 'ui',
  hook: 'hook',
  store: 'store',
  adapter: 'adapter',
  backend: 'backend',
};

const REVERSE_STAGE_MAP: Record<ChatV2LogStage, LegacyStage> = {
  ui: 'chip',
  hook: 'hook',
  store: 'store',
  adapter: 'adapter',
  middleware: 'adapter',
  backend: 'backend',
  poll: 'hook',
};

// =============================================================================
// 兼容函数（桥接到新日志系统）
// =============================================================================

/**
 * 记录多变体流程日志（兼容旧 API，桥接到新系统）
 */
export function logMultiVariant(
  stage: LegacyStage,
  action: string,
  data: Record<string, unknown>,
  severity: LegacySeverity = 'info'
): void {
  const mappedStage = STAGE_MAP[stage];
  
  // 根据 action 判断分类
  let category: ChatV2LogCategory = 'variant';
  const actionLower = action.toLowerCase();
  if (actionLower.includes('session')) {
    category = 'session';
  } else if (actionLower.includes('thinking') || actionLower.includes('reasoning')) {
    category = 'thinking';
  } else if (actionLower.includes('block')) {
    category = 'block';
  } else if (actionLower.includes('message')) {
    category = 'message';
  } else if (actionLower.includes('event') || actionLower.includes('sequence')) {
    category = 'event';
  }
  
  logChatV2(category, mappedStage, action, data, severity);
}

export function clearMultiVariantLogs(): void {
  clearChatV2Logs();
}

// =============================================================================
// 全局注入（兼容）
// =============================================================================

function injectMultiVariantDebug() {
  (window as any).__multiVariantDebug = {
    log: logMultiVariant,
    clear: clearMultiVariantLogs,
    getLogs: () => getChatV2Logs().map(log => ({
      id: log.id,
      timestamp: log.timestamp,
      stage: REVERSE_STAGE_MAP[log.stage] || 'adapter',
      action: log.action,
      data: log.data,
      severity: log.severity === 'debug' ? 'info' : log.severity,
    })),
  };
}

// 立即注入
injectMultiVariantDebug();

// =============================================================================
// 组件
// =============================================================================

const MultiVariantDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
}) => {
  const [logs, setLogs] = useState<ChatV2LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // 监听日志事件
  useEffect(() => {
    if (!isActive) return;

    const handleLogAdded = (e: Event) => {
      const entry = (e as CustomEvent<ChatV2LogEntry>).detail;
      setLogs(prev => [...prev, entry]);
    };

    const handleLogsCleared = () => {
      setLogs([]);
    };

    // 初始加载已有日志
    setLogs(getChatV2Logs());

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
  }, [logs, autoScroll]);

  const handleClear = useCallback(() => {
    clearChatV2Logs();
  }, []);

  const handleCopyLogs = useCallback(() => {
    const stats = getChatV2LogStats();
    const report = {
      title: 'Chat V2 调试报告',
      generatedAt: new Date().toISOString(),
      logsCount: logs.length,
      logs: logs.map(l => ({
        ...l,
        data: JSON.parse(JSON.stringify(l.data)),
      })),
      summary: {
        stages: stats.byStage,
        categories: stats.byCategory,
        severities: stats.bySeverity,
        flow: logs.map(l => `${l.stage}:${l.action}`).join(' → '),
      },
    };

    copyTextToClipboard(JSON.stringify(report, null, 2));
    console.log('📋 Chat V2 调试日志已复制到剪贴板');
  }, [logs]);

  if (!visible || !isActive) return null;

  const getSeverityIcon = (severity: ChatV2LogEntry['severity']) => {
    switch (severity) {
      case 'error':
        return <WarningCircle size={16} className="text-red-500" />;
      case 'warning':
        return <Warning size={16} className="text-yellow-500" />;
      case 'success':
        return <CheckCircle size={16} className="text-green-500" />;
      case 'debug':
        return <Bug size={16} className="text-gray-500" />;
      default:
        return <ArrowRight size={16} className="text-blue-500" />;
    }
  };

  const getStageBadgeColor = (stage: ChatV2LogStage) => {
    switch (stage) {
      case 'ui':
        return 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200';
      case 'hook':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'store':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'adapter':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'middleware':
        return 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200';
      case 'backend':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200';
    }
  };

  const getCategoryBadgeColor = (category: ChatV2LogCategory) => {
    switch (category) {
      case 'variant':
        return 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200';
      case 'message':
        return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200';
      case 'block':
        return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
      case 'event':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
      case 'session':
        return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200';
      case 'error':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200';
    }
  };

  // 统计
  const stats = getChatV2LogStats();

  return (
    <div className="flex flex-col h-full p-4 space-y-4 overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Stack size={20} className="text-primary" />
          <h3 className="text-lg font-semibold">多变体并行调试</h3>
          <Badge variant="outline">{logs.length} 条日志</Badge>
        </div>
        <div className="flex items-center gap-2">
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

      {/* 流程阶段统计 */}
      <div className="flex gap-2 flex-wrap flex-shrink-0">
        <Badge className={getStageBadgeColor('ui')}>UI: {stats.byStage.ui}</Badge>
        <span className="text-muted-foreground">→</span>
        <Badge className={getStageBadgeColor('hook')}>Hook: {stats.byStage.hook}</Badge>
        <span className="text-muted-foreground">→</span>
        <Badge className={getStageBadgeColor('store')}>Store: {stats.byStage.store}</Badge>
        <span className="text-muted-foreground">→</span>
        <Badge className={getStageBadgeColor('adapter')}>Adapter: {stats.byStage.adapter}</Badge>
        <span className="text-muted-foreground">→</span>
        <Badge className={getStageBadgeColor('middleware')}>MW: {stats.byStage.middleware}</Badge>
        <span className="text-muted-foreground">→</span>
        <Badge className={getStageBadgeColor('backend')}>Backend: {stats.byStage.backend}</Badge>
      </div>

      {/* 分类统计 */}
      <div className="flex gap-1 flex-wrap flex-shrink-0 text-xs">
        <Badge className={getCategoryBadgeColor('variant')} variant="outline">变体: {stats.byCategory.variant}</Badge>
        <Badge className={getCategoryBadgeColor('message')} variant="outline">消息: {stats.byCategory.message}</Badge>
        <Badge className={getCategoryBadgeColor('block')} variant="outline">块: {stats.byCategory.block}</Badge>
        <Badge className={getCategoryBadgeColor('event')} variant="outline">事件: {stats.byCategory.event}</Badge>
        <Badge className={getCategoryBadgeColor('session')} variant="outline">会话: {stats.byCategory.session}</Badge>
        {stats.byCategory.error > 0 && (
          <Badge className={getCategoryBadgeColor('error')} variant="outline">错误: {stats.byCategory.error}</Badge>
        )}
      </div>

      {/* 使用说明 */}
      <Card className="flex-shrink-0">
        <CardHeader className="py-2">
          <CardTitle className="text-sm">使用说明</CardTitle>
        </CardHeader>
        <CardContent className="py-2 text-xs text-muted-foreground">
          <ol className="list-decimal list-inside space-y-1">
            <li>点击"清空"清除旧日志</li>
            <li>在输入框中选择 2+ 个模型（@模型名）</li>
            <li>发送消息，观察日志流转</li>
            <li>检查每个阶段是否正确传递 modelIds</li>
          </ol>
          <div className="mt-2 p-2 bg-muted rounded text-[10px]">
            <strong>预期流程：</strong><br/>
            Chip选择 → Hook.getSelectedModels → Store.setPendingParallelModelIds → 
            Adapter.buildSendOptions → Backend.execute_multi_variant
          </div>
        </CardContent>
      </Card>

      {/* 日志列表 */}
      <div className="flex-1 overflow-auto border rounded-md p-2 space-y-2 bg-muted/30">
        {logs.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            <Stack size={48} className="mx-auto mb-2 opacity-50" />
            <p>暂无日志</p>
            <p className="text-xs">选择 2+ 个模型并发送消息开始追踪</p>
          </div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className="flex items-start gap-2 p-2 bg-background rounded border text-xs"
            >
              {getSeverityIcon(log.severity)}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Badge className={`text-[10px] px-1.5 py-0 ${getCategoryBadgeColor(log.category)}`}>
                    {log.category}
                  </Badge>
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
    </div>
  );
};

export default MultiVariantDebugPlugin;
