import { copyTextToClipboard } from '@/utils/clipboardUtils';

/**
 * SubagentTestPlugin - 子代理自动测试插件
 *
 * 功能：
 * 1. 一键启动子代理自动测试
 * 2. 实时显示 UI 渲染情况和用户操作日志
 * 3. 生成并下载测试报告
 *
 * @since 2026-01-21
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { Separator } from '../../components/ui/shad/Separator';
import { Input } from '../../components/ui/shad/Input';
import { Textarea } from '../../components/ui/shad/Textarea';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import {
  Copy,
  Trash,
  Play,
  Square,
  Download,
  ArrowClockwise,
  CheckCircle,
  WarningCircle,
  Clock,
  CircleNotch,
  Robot,
  Eye,
  Cursor,
  Database,
  RadioButton,
  Warning,
  FileJs,
  ChartBar,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  startTest,
  stopTest,
  getLogs,
  getLogsByType,
  clearLogs,
  generateReport,
  downloadReport,
  getTestStatus,
  getConfig,
  updateConfig,
  type SubagentLogEntry,
  type SubagentLogType,
  type TestStatus,
  type SubagentTestConfig,
  type SubagentTestReport,
} from '../../features/chat/debug/subagentTestPlugin';

// =============================================================================
// 类型定义
// =============================================================================

type LogFilter = 'all' | SubagentLogType;

// =============================================================================
// 工具函数
// =============================================================================

function getLogTypeIcon(type: SubagentLogType) {
  switch (type) {
    case 'lifecycle':
      return <ArrowClockwise size={12} />;
    case 'task':
      return <Database size={12} />; // 🆕 任务持久化
    case 'ui_render':
      return <Eye size={12} />;
    case 'ui_interaction':
      return <Cursor size={12} />;
    case 'data_load':
      return <Database size={12} />;
    case 'event':
      return <RadioButton size={12} />;
    case 'error':
      return <Warning size={12} />;
    case 'test':
      return <Robot size={12} />;
    default:
      return <Clock size={12} />;
  }
}

function getLogTypeBadgeVariant(type: SubagentLogType): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (type) {
    case 'error':
      return 'destructive';
    case 'lifecycle':
    case 'task':  // 🆕 任务持久化也用 default
      return 'default';
    case 'ui_render':
    case 'ui_interaction':
      return 'secondary';
    default:
      return 'outline';
  }
}

function getStatusIcon(status: TestStatus) {
  switch (status) {
    case 'running':
      return <CircleNotch size={16} className="animate-spin text-green-500" />;
    case 'completed':
      return <CheckCircle size={16} className="text-blue-500" />;
    case 'failed':
      return <WarningCircle size={16} className="text-red-500" />;
    default:
      return <Clock size={16} className="text-gray-400" />;
  }
}

function getStatusLabel(status: TestStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return '空闲';
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const ms = date.getMilliseconds().toString().padStart(3, '0');
  return `${timeStr}.${ms}`;
}

// =============================================================================
// 组件
// =============================================================================

const SubagentTestPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<SubagentLogEntry[]>([]);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [status, setStatus] = useState<TestStatus>('idle');
  const [config, setConfig] = useState<SubagentTestConfig>(getConfig());
  const [showConfig, setShowConfig] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 刷新日志
  const refreshLogs = useCallback(() => {
    const allLogs = filter === 'all' ? getLogs() : getLogsByType(filter);
    setLogs(allLogs);
    setStatus(getTestStatus());
  }, [filter]);

  // 监听日志事件
  useEffect(() => {
    if (!isActivated) return;

    const handleLogEvent = () => {
      refreshLogs();
    };

    window.addEventListener('SUBAGENT_TEST_LOG', handleLogEvent);
    refreshLogs();

    return () => {
      window.removeEventListener('SUBAGENT_TEST_LOG', handleLogEvent);
    };
  }, [isActivated, refreshLogs]);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  // 启动测试
  const handleStartTest = async () => {
    await startTest(config);
  };

  // 停止测试
  const handleStopTest = async () => {
    await stopTest();
    refreshLogs();
  };

  // 清空日志
  const handleClearLogs = () => {
    clearLogs();
    setLogs([]);
  };

  // 复制日志
  const handleCopyLogs = () => {
    const text = logs
      .map((log) => `[${formatTimestamp(log.timestamp)}][${log.type}] ${log.action}: ${JSON.stringify(log.data)}`)
      .join('\n');
    copyTextToClipboard(text);
  };

  // 下载报告
  const handleDownloadReport = () => {
    downloadReport();
  };

  // 生成报告摘要
  const report = generateReport();

  if (!visible || !isActive) return null;

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      {/* 头部控制区 */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center justify-between text-base">
            <div className="flex items-center gap-2">
              <Robot size={20} />
              <span>子代理自动测试</span>
              {getStatusIcon(status)}
              <Badge variant={status === 'running' ? 'default' : 'secondary'}>
                {getStatusLabel(status)}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {status === 'running' ? (
                <Button size="sm" variant="destructive" onClick={handleStopTest}>
                  <Square size={16} className="mr-1" />
                  停止
                </Button>
              ) : (
                <Button size="sm" onClick={handleStartTest}>
                  <Play size={16} className="mr-1" />
                  启动测试
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setShowConfig(!showConfig)}>
                配置
              </Button>
            </div>
          </CardTitle>
        </CardHeader>

        {/* 配置面板 */}
        {showConfig && (
          <CardContent className="pt-0">
            <div className="grid gap-3">
              <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm">
                <p className="font-medium mb-1">🤖 全自动测试</p>
                <p className="text-muted-foreground text-xs">
                  插件将通过真实对话流程发送 Prompt，让 LLM 自动触发 <code className="bg-muted px-1 rounded">subagent_call</code> 工具创建子代理。
                </p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">测试 Prompt</label>
                <Textarea
                  value={config.testPrompt}
                  onChange={(e) => {
                    const newConfig = { ...config, testPrompt: e.target.value };
                    setConfig(newConfig);
                    updateConfig(newConfig);
                  }}
                  rows={2}
                  className="mt-1"
                  placeholder="发送给 LLM 的消息，用于触发 subagent_call"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">超时时间 (ms)</label>
                <Input
                  type="number"
                  value={config.testTimeout}
                  onChange={(e) => {
                    const newConfig = { ...config, testTimeout: parseInt(e.target.value) || 120000 };
                    setConfig(newConfig);
                    updateConfig(newConfig);
                  }}
                  className="mt-1"
                />
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* 统计摘要 */}
      <Card>
        <CardContent className="py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-1">
                <ChartBar size={16} className="text-muted-foreground" />
                <span className="text-muted-foreground">总日志:</span>
                <Badge variant="outline">{report.totalLogs}</Badge>
              </div>
              <span className="text-muted-foreground">|</span>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={report.summary.subagentCreated ? 'default' : 'secondary'}>
                  创建 {report.summary.subagentCreated ? '✓' : '✗'}
                </Badge>
                <Badge variant={report.summary.taskPersisted ? 'default' : 'secondary'}>
                  持久化 {report.summary.taskPersisted ? '✓' : '✗'}
                </Badge>
                <Badge variant={report.summary.taskStarted ? 'default' : 'secondary'}>
                  启动 {report.summary.taskStarted ? '✓' : '✗'}
                </Badge>
                <Badge variant={report.summary.subagentCompleted ? 'default' : 'secondary'}>
                  完成 {report.summary.subagentCompleted ? '✓' : '✗'}
                </Badge>
                <Badge variant={report.summary.uiRenderedCorrectly ? 'default' : 'secondary'}>
                  UI {report.summary.uiRenderedCorrectly ? '✓' : '✗'}
                </Badge>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={handleCopyLogs} title="复制日志">
                <Copy size={16} />
              </Button>
              <Button size="sm" variant="ghost" onClick={handleDownloadReport} title="下载报告">
                <Download size={16} />
              </Button>
              <Button size="sm" variant="ghost" onClick={handleClearLogs} title="清空">
                <Trash size={16} />
              </Button>
              <Button size="sm" variant="ghost" onClick={refreshLogs} title="刷新">
                <ArrowClockwise size={16} />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 过滤器 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground">过滤:</span>
        {(['all', 'lifecycle', 'task', 'ui_render', 'ui_interaction', 'data_load', 'event', 'error', 'test'] as const).map(
          (type) => (
            <Button
              key={type}
              size="sm"
              variant={filter === type ? 'default' : 'outline'}
              onClick={() => setFilter(type)}
              className="h-7 text-xs"
            >
              {type === 'all' ? '全部' : type}
              {type !== 'all' && (
                <Badge variant="secondary" className="ml-1 h-4 px-1">
                  {report.logsByType[type]}
                </Badge>
              )}
            </Button>
          )
        )}
      </div>

      {/* 日志列表 */}
      <Card className="flex-1 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollRef}>
          <div className="p-3 space-y-2">
            {logs.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <Robot size={32} className="mx-auto mb-2 opacity-50" />
                <p>暂无日志</p>
                <p className="text-xs mt-1">点击"启动测试"开始自动测试</p>
              </div>
            ) : (
              logs.map((log) => (
                <div
                  key={log.id}
                  className={`flex items-start gap-2 p-2 rounded-lg border text-sm ${
                    log.type === 'error' ? 'bg-destructive/10 border-destructive/30' : 'bg-muted/30'
                  }`}
                >
                  <div className="flex-shrink-0 mt-0.5">{getLogTypeIcon(log.type)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={getLogTypeBadgeVariant(log.type)} className="text-xs">
                        {log.type}
                      </Badge>
                      <span className="font-medium">{log.action}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatTimestamp(log.timestamp)}
                      </span>
                      {log.durationMs !== undefined && (
                        <Badge variant="outline" className="text-xs">
                          {log.durationMs}ms
                        </Badge>
                      )}
                    </div>
                    {Object.keys(log.data).length > 0 && (
                      <pre className="mt-1 text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(log.data, null, 2)}
                      </pre>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </Card>
    </div>
  );
};

export default SubagentTestPlugin;
