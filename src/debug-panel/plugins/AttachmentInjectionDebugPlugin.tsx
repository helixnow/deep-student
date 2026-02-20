import { copyTextToClipboard } from '@/utils/clipboardUtils';

/**
 * AttachmentInjectionDebugPlugin - 附件注入调试插件
 *
 * 追踪附件上传到消息发送的完整数据流：
 * 1. UI 层：AttachmentUploader 上传
 * 2. Store 层：addContextRef 添加引用
 * 3. Adapter 层：buildSendContextRefs 构建
 * 4. Backend 层：vfs_resolve_resource_refs 解析
 * 5. 格式化：formatToBlocks 生成内容块
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import {
  Upload,
  Trash2,
  Copy,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileImage,
  FileText,
  ArrowRight,
  RefreshCw,
  Database,
  Layers,
  Server,
} from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  getChatV2Logs,
  clearChatV2Logs,
  CHATV2_LOG_EVENT,
  CHATV2_LOGS_CLEARED,
  type ChatV2LogEntry,
} from '../../chat-v2/debug/chatV2Logger';

// =============================================================================
// 常量
// =============================================================================

const STAGE_ICONS: Record<string, React.ReactNode> = {
  ui: <Upload className="w-3 h-3" />,
  store: <Layers className="w-3 h-3" />,
  adapter: <Database className="w-3 h-3" />,
  backend: <Server className="w-3 h-3" />,
};

const STAGE_COLORS: Record<string, string> = {
  ui: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  store: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  adapter: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  backend: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
};

const SEVERITY_ICONS: Record<string, React.ReactNode> = {
  success: <CheckCircle2 className="w-3 h-3 text-green-500" />,
  error: <XCircle className="w-3 h-3 text-red-500" />,
  warning: <AlertTriangle className="w-3 h-3 text-yellow-500" />,
  info: <ArrowRight className="w-3 h-3 text-blue-500" />,
  debug: <RefreshCw className="w-3 h-3 text-gray-500" />,
};

// =============================================================================
// 辅助函数
// =============================================================================

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${time}.${ms}`;
}

function formatDataPreview(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

// =============================================================================
// 日志条目组件
// =============================================================================

const LogEntry: React.FC<{
  log: ChatV2LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ log, isExpanded, onToggle }) => {
  const stageIcon = STAGE_ICONS[log.stage] || <ArrowRight className="w-3 h-3" />;
  const stageColor = STAGE_COLORS[log.stage] || 'bg-gray-100 text-gray-800';
  const severityIcon = SEVERITY_ICONS[log.severity] || SEVERITY_ICONS.info;

  return (
    <div
      className={`border rounded-lg mb-2 overflow-hidden transition-colors ${
        log.severity === 'error'
          ? 'border-red-300 dark:border-red-700 bg-red-50/50 dark:bg-red-950/20'
          : log.severity === 'warning'
            ? 'border-yellow-300 dark:border-yellow-700 bg-yellow-50/50 dark:bg-yellow-950/20'
            : 'border-border'
      }`}
    >
      <div
        className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50"
        onClick={onToggle}
      >
        {severityIcon}
        <Badge className={`${stageColor} text-xs px-1.5 py-0`}>
          {stageIcon}
          <span className="ml-1">{log.stage}</span>
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">{formatTimestamp(log.timestamp)}</span>
        <span className="font-medium text-sm flex-1 truncate">{log.action}</span>
        {log.data?.fileName && (
          <Badge variant="outline" className="text-xs">
            {log.data.fileName as string}
          </Badge>
        )}
      </div>

      {isExpanded && (
        <div className="border-t p-2 bg-muted/30">
          <pre className="text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-60">
            {formatDataPreview(log.data)}
          </pre>
        </div>
      )}
    </div>
  );
};

// =============================================================================
// 主组件
// =============================================================================

const AttachmentInjectionDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<ChatV2LogEntry[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const [stageFilter, setStageFilter] = useState<string | null>(null);

  // 加载日志
  const loadLogs = useCallback(() => {
    const allLogs = getChatV2Logs();
    // 只显示 attachment 分类的日志
    const attachmentLogs = allLogs.filter((log) => log.category === 'attachment');
    setLogs(attachmentLogs);
  }, []);

  // 监听新日志
  useEffect(() => {
    if (!isActivated) return;

    loadLogs();

    const handleNewLog = (e: CustomEvent<ChatV2LogEntry>) => {
      if (e.detail.category === 'attachment') {
        setLogs((prev) => [...prev, e.detail]);
      }
    };

    const handleClear = () => {
      setLogs([]);
    };

    window.addEventListener(CHATV2_LOG_EVENT, handleNewLog as EventListener);
    window.addEventListener(CHATV2_LOGS_CLEARED, handleClear);

    return () => {
      window.removeEventListener(CHATV2_LOG_EVENT, handleNewLog as EventListener);
      window.removeEventListener(CHATV2_LOGS_CLEARED, handleClear);
    };
  }, [isActivated, loadLogs]);

  // 清空日志
  const handleClear = useCallback(() => {
    clearChatV2Logs();
    setLogs([]);
    setExpandedIds(new Set());
  }, []);

  // 复制日志
  const handleCopy = useCallback(() => {
    const text = logs
      .map((log) => `[${log.timestamp}] [${log.stage}] ${log.action}\n${formatDataPreview(log.data)}`)
      .join('\n\n---\n\n');
    copyTextToClipboard(text);
  }, [logs]);

  // 切换展开
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 过滤日志
  const filteredLogs = stageFilter ? logs.filter((log) => log.stage === stageFilter) : logs;

  // 统计
  const stats = {
    total: logs.length,
    errors: logs.filter((l) => l.severity === 'error').length,
    warnings: logs.filter((l) => l.severity === 'warning').length,
    byStage: {
      ui: logs.filter((l) => l.stage === 'ui').length,
      store: logs.filter((l) => l.stage === 'store').length,
      adapter: logs.filter((l) => l.stage === 'adapter').length,
      backend: logs.filter((l) => l.stage === 'backend').length,
    },
  };

  if (!visible) return null;

  return (
    <div className="h-full flex flex-col">
      {/* 标题栏 */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <FileImage className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">附件注入调试</h3>
          <Badge variant="outline">{logs.length} 条日志</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadLogs}>
            <RefreshCw className="w-4 h-4 mr-1" />
            刷新
          </Button>
          <Button variant="outline" size="sm" onClick={handleCopy} disabled={logs.length === 0}>
            <Copy className="w-4 h-4 mr-1" />
            复制
          </Button>
          <Button variant="outline" size="sm" onClick={handleClear} disabled={logs.length === 0}>
            <Trash2 className="w-4 h-4 mr-1" />
            清空
          </Button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="p-3 border-b">
        <div className="grid grid-cols-6 gap-2">
          <Card
            className={`cursor-pointer transition-colors ${stageFilter === null ? 'ring-2 ring-primary' : ''}`}
            onClick={() => setStageFilter(null)}
          >
            <CardContent className="p-2 text-center">
              <div className="text-lg font-bold">{stats.total}</div>
              <div className="text-xs text-muted-foreground">全部</div>
            </CardContent>
          </Card>
          {(['ui', 'store', 'adapter', 'backend'] as const).map((stage) => (
            <Card
              key={stage}
              className={`cursor-pointer transition-colors ${stageFilter === stage ? 'ring-2 ring-primary' : ''}`}
              onClick={() => setStageFilter(stageFilter === stage ? null : stage)}
            >
              <CardContent className="p-2 text-center">
                <div className="flex items-center justify-center gap-1">
                  {STAGE_ICONS[stage]}
                  <span className="text-lg font-bold">{stats.byStage[stage]}</span>
                </div>
                <div className="text-xs text-muted-foreground">{stage}</div>
              </CardContent>
            </Card>
          ))}
          <Card className={stats.errors > 0 ? 'border-red-300 dark:border-red-700' : ''}>
            <CardContent className="p-2 text-center">
              <div className="flex items-center justify-center gap-1">
                <XCircle className={`w-4 h-4 ${stats.errors > 0 ? 'text-red-500' : 'text-muted-foreground'}`} />
                <span className={`text-lg font-bold ${stats.errors > 0 ? 'text-red-500' : ''}`}>{stats.errors}</span>
              </div>
              <div className="text-xs text-muted-foreground">错误</div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 日志列表 */}
      <ScrollArea className="flex-1 p-3">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
            <FileText className="w-12 h-12 mb-2 opacity-30" />
            <p>暂无附件日志</p>
            <p className="text-xs mt-1">上传附件后将在此显示调试信息</p>
          </div>
        ) : (
          filteredLogs.map((log) => (
            <LogEntry
              key={log.id}
              log={log}
              isExpanded={expandedIds.has(log.id)}
              onToggle={() => toggleExpanded(log.id)}
            />
          ))
        )}
      </ScrollArea>

      {/* 管线说明 */}
      <div className="p-3 border-t bg-muted/30">
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Badge className={STAGE_COLORS.ui}>UI: 上传</Badge>
          <ArrowRight className="w-3 h-3" />
          <Badge className={STAGE_COLORS.store}>Store: 引用</Badge>
          <ArrowRight className="w-3 h-3" />
          <Badge className={STAGE_COLORS.adapter}>Adapter: 构建</Badge>
          <ArrowRight className="w-3 h-3" />
          <Badge className={STAGE_COLORS.backend}>Backend: 解析</Badge>
        </div>
      </div>
    </div>
  );
};

export default AttachmentInjectionDebugPlugin;
