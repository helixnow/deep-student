/**
 * PdfMultimodalDebugPlugin - PDF 多模态注入调试插件
 *
 * 专门用于调试 PDF 图片模式注入的问题：
 * 1. 追踪 isMultimodal 的值
 * 2. 监听 multimodalBlocks 的传递
 * 3. 显示 formatToBlocks 的输入输出
 * 4. 显示前端和后端的关键日志
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent } from '../../components/ui/shad/Card';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import {
  Trash2,
  Copy,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileImage,
  FileText,
  RefreshCw,
  Image as ImageIcon,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// =============================================================================
// 类型定义
// =============================================================================

interface PdfDebugLog {
  id: string;
  timestamp: string;
  source: 'frontend' | 'backend' | 'format';
  level: 'info' | 'debug' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

// =============================================================================
// 全局日志存储
// =============================================================================

const PDF_DEBUG_LOGS: PdfDebugLog[] = [];
const PDF_DEBUG_EVENT = 'pdf-multimodal-debug-log';
let logIdCounter = 0;

function addPdfDebugLog(
  source: PdfDebugLog['source'],
  level: PdfDebugLog['level'],
  message: string,
  data?: Record<string, unknown>
) {
  const log: PdfDebugLog = {
    id: `pdf_${++logIdCounter}`,
    timestamp: new Date().toISOString(),
    source,
    level,
    message,
    data,
  };
  PDF_DEBUG_LOGS.push(log);
  // 限制最大日志数
  if (PDF_DEBUG_LOGS.length > 500) {
    PDF_DEBUG_LOGS.shift();
  }
  window.dispatchEvent(new CustomEvent(PDF_DEBUG_EVENT, { detail: log }));
}

function clearPdfDebugLogs() {
  PDF_DEBUG_LOGS.length = 0;
  window.dispatchEvent(new CustomEvent('pdf-multimodal-debug-cleared'));
}

function getPdfDebugLogs(): PdfDebugLog[] {
  return [...PDF_DEBUG_LOGS];
}

// =============================================================================
// 拦截 console 输出
// =============================================================================

let isIntercepting = false;
const originalConsole = {
  log: console.log,
  debug: console.debug,
  warn: console.warn,
  error: console.error,
};

function startInterceptingConsole() {
  if (isIntercepting) return;
  isIntercepting = true;

  const intercept = (level: 'info' | 'debug' | 'warn' | 'error', originalFn: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      originalFn.apply(console, args);
      
      // 将参数转为字符串
      const message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(' ');

      // 检查是否是 PDF 相关的日志
      const isPdfDebug = 
        message.includes('[PDF_DEBUG') ||
        message.includes('[FileDefinition]') ||
        message.includes('[ImageDefinition]') ||
        message.includes('multimodalBlocks') ||
        message.includes('multimodal_blocks') ||
        message.includes('isMultimodal') ||
        message.includes('includeImage') ||
        message.includes('inject_modes') ||
        message.includes('injectModes');

      if (isPdfDebug) {
        // 解析数据对象
        let data: Record<string, unknown> | undefined;
        for (let i = 1; i < args.length; i++) {
          if (typeof args[i] === 'object' && args[i] !== null) {
            data = args[i] as Record<string, unknown>;
            break;
          }
        }

        // 判断来源
        let source: PdfDebugLog['source'] = 'frontend';
        if (message.includes('[PDF_DEBUG]') || message.includes('backend')) {
          source = 'backend';
        } else if (message.includes('[FileDefinition]') || message.includes('formatToBlocks')) {
          source = 'format';
        }

        addPdfDebugLog(source, level, message, data);
      }
    };
  };

  console.log = intercept('info', originalConsole.log);
  console.debug = intercept('debug', originalConsole.debug);
  console.warn = intercept('warn', originalConsole.warn);
  console.error = intercept('error', originalConsole.error);
}

function stopInterceptingConsole() {
  if (!isIntercepting) return;
  isIntercepting = false;
  console.log = originalConsole.log;
  console.debug = originalConsole.debug;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
}

// =============================================================================
// 导出全局 API（供其他模块调用）
// =============================================================================

export const pdfMultimodalDebug = {
  log: (message: string, data?: Record<string, unknown>) => addPdfDebugLog('frontend', 'info', message, data),
  debug: (message: string, data?: Record<string, unknown>) => addPdfDebugLog('frontend', 'debug', message, data),
  warn: (message: string, data?: Record<string, unknown>) => addPdfDebugLog('frontend', 'warn', message, data),
  error: (message: string, data?: Record<string, unknown>) => addPdfDebugLog('frontend', 'error', message, data),
  format: (message: string, data?: Record<string, unknown>) => addPdfDebugLog('format', 'info', message, data),
  clear: clearPdfDebugLogs,
};

// 挂载到 window 以便调试
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).pdfMultimodalDebug = pdfMultimodalDebug;
}

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

function formatDataPreview(data: Record<string, unknown> | undefined): string {
  if (!data) return '';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

// =============================================================================
// 日志条目组件
// =============================================================================

const SOURCE_COLORS: Record<string, string> = {
  frontend: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  backend: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  format: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
};

const LEVEL_ICONS: Record<string, React.ReactNode> = {
  info: <CheckCircle2 className="w-3 h-3 text-blue-500" />,
  debug: <RefreshCw className="w-3 h-3 text-gray-500" />,
  warn: <AlertTriangle className="w-3 h-3 text-yellow-500" />,
  error: <XCircle className="w-3 h-3 text-red-500" />,
};

const LogEntry: React.FC<{
  log: PdfDebugLog;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ log, isExpanded, onToggle }) => {
  const sourceColor = SOURCE_COLORS[log.source] || 'bg-gray-100 text-gray-800';
  const levelIcon = LEVEL_ICONS[log.level] || LEVEL_ICONS.info;

  // 高亮关键字
  const highlightMessage = (msg: string) => {
    const keywords = ['isMultimodal', 'multimodalBlocks', 'includeImage', 'blocks_count', 'Image', 'true', 'false'];
    let result = msg;
    keywords.forEach(kw => {
      const regex = new RegExp(`(${kw})`, 'gi');
      result = result.replace(regex, '<mark class="bg-yellow-200 dark:bg-yellow-800 px-0.5 rounded">$1</mark>');
    });
    return result;
  };

  return (
    <div
      className={`border rounded-lg mb-2 overflow-hidden transition-colors ${
        log.level === 'error'
          ? 'border-red-300 dark:border-red-700 bg-red-50/50 dark:bg-red-950/20'
          : log.level === 'warn'
            ? 'border-yellow-300 dark:border-yellow-700 bg-yellow-50/50 dark:bg-yellow-950/20'
            : 'border-border'
      }`}
    >
      <div
        className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50"
        onClick={onToggle}
      >
        {levelIcon}
        <Badge className={`${sourceColor} text-xs px-1.5 py-0`}>
          {log.source}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">{formatTimestamp(log.timestamp)}</span>
        <span 
          className="font-medium text-xs flex-1 truncate"
          dangerouslySetInnerHTML={{ __html: highlightMessage(log.message.slice(0, 150)) }}
        />
        {log.data && (
          <Badge variant="outline" className="text-xs">
            有数据
          </Badge>
        )}
      </div>

      {isExpanded && (
        <div className="border-t p-2 bg-muted/30">
          <div className="text-xs font-mono whitespace-pre-wrap break-all mb-2"
            dangerouslySetInnerHTML={{ __html: highlightMessage(log.message) }}
          />
          {log.data && (
            <pre className="text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-60 bg-background p-2 rounded">
              {formatDataPreview(log.data)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// 主组件
// =============================================================================

const PdfMultimodalDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActivated,
}) => {
  const [logs, setLogs] = useState<PdfDebugLog[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 开始/停止捕获
  const toggleCapture = useCallback(() => {
    if (isCapturing) {
      stopInterceptingConsole();
      setIsCapturing(false);
    } else {
      startInterceptingConsole();
      setIsCapturing(true);
    }
  }, [isCapturing]);

  // 加载日志
  const loadLogs = useCallback(() => {
    setLogs(getPdfDebugLogs());
  }, []);

  // 监听新日志
  useEffect(() => {
    if (!isActivated) return;

    loadLogs();

    // 自动开始捕获
    if (!isCapturing) {
      startInterceptingConsole();
      setIsCapturing(true);
    }

    const handleNewLog = (e: CustomEvent<PdfDebugLog>) => {
      setLogs((prev) => [...prev, e.detail]);
    };

    const handleClear = () => {
      setLogs([]);
    };

    window.addEventListener(PDF_DEBUG_EVENT, handleNewLog as EventListener);
    window.addEventListener('pdf-multimodal-debug-cleared', handleClear);

    return () => {
      window.removeEventListener(PDF_DEBUG_EVENT, handleNewLog as EventListener);
      window.removeEventListener('pdf-multimodal-debug-cleared', handleClear);
    };
  }, [isActivated, loadLogs, isCapturing]);

  // 清空日志
  const handleClear = useCallback(() => {
    clearPdfDebugLogs();
    setLogs([]);
    setExpandedIds(new Set());
  }, []);

  // 复制日志
  const handleCopy = useCallback(() => {
    const text = logs
      .map((log) => `[${log.timestamp}] [${log.source}] [${log.level}] ${log.message}\n${formatDataPreview(log.data)}`)
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

  // 展开全部
  const expandAll = useCallback(() => {
    setExpandedIds(new Set(logs.map(l => l.id)));
  }, [logs]);

  // 折叠全部
  const collapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  // 过滤日志
  const filteredLogs = sourceFilter ? logs.filter((log) => log.source === sourceFilter) : logs;

  // 统计
  const stats = {
    total: logs.length,
    errors: logs.filter((l) => l.level === 'error').length,
    warnings: logs.filter((l) => l.level === 'warn').length,
    bySource: {
      frontend: logs.filter((l) => l.source === 'frontend').length,
      backend: logs.filter((l) => l.source === 'backend').length,
      format: logs.filter((l) => l.source === 'format').length,
    },
  };

  // 检查关键状态
  const hasMultimodalBlocks = logs.some(l => l.message.includes('blocks_count') || l.message.includes('multimodalBlocks'));
  const isMultimodalTrue = logs.some(l => l.message.includes('isMultimodal') && (l.message.includes('true') || l.message.includes(': true')));
  const includeImageTrue = logs.some(l => l.message.includes('includeImage') && (l.message.includes('true') || l.message.includes(': true')));

  if (!visible) return null;

  return (
    <div className="h-full flex flex-col">
      {/* 标题栏 */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">PDF 多模态调试</h3>
          <Badge variant="outline">{logs.length} 条日志</Badge>
          {isCapturing ? (
            <Badge className="bg-green-500 text-white animate-pulse">捕获中</Badge>
          ) : (
            <Badge variant="secondary">已停止</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant={isCapturing ? 'destructive' : 'default'} size="sm" onClick={toggleCapture}>
            {isCapturing ? <EyeOff className="w-4 h-4 mr-1" /> : <Eye className="w-4 h-4 mr-1" />}
            {isCapturing ? '停止' : '开始'}
          </Button>
          <Button variant="outline" size="sm" onClick={loadLogs}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={expandAll}>
            展开
          </Button>
          <Button variant="outline" size="sm" onClick={collapseAll}>
            折叠
          </Button>
          <Button variant="outline" size="sm" onClick={handleCopy} disabled={logs.length === 0}>
            <Copy className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleClear} disabled={logs.length === 0}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* 关键状态检查 */}
      <div className="p-3 border-b bg-muted/30">
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1">
            {hasMultimodalBlocks ? (
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            ) : (
              <XCircle className="w-4 h-4 text-red-500" />
            )}
            <span>multimodalBlocks</span>
          </div>
          <div className="flex items-center gap-1">
            {isMultimodalTrue ? (
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            ) : (
              <XCircle className="w-4 h-4 text-red-500" />
            )}
            <span>isMultimodal=true</span>
          </div>
          <div className="flex items-center gap-1">
            {includeImageTrue ? (
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            ) : (
              <XCircle className="w-4 h-4 text-red-500" />
            )}
            <span>includeImage=true</span>
          </div>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="p-3 border-b">
        <div className="grid grid-cols-5 gap-2">
          <Card
            className={`cursor-pointer transition-colors ${sourceFilter === null ? 'ring-2 ring-primary' : ''}`}
            onClick={() => setSourceFilter(null)}
          >
            <CardContent className="p-2 text-center">
              <div className="text-lg font-bold">{stats.total}</div>
              <div className="text-xs text-muted-foreground">全部</div>
            </CardContent>
          </Card>
          {(['frontend', 'backend', 'format'] as const).map((source) => (
            <Card
              key={source}
              className={`cursor-pointer transition-colors ${sourceFilter === source ? 'ring-2 ring-primary' : ''}`}
              onClick={() => setSourceFilter(sourceFilter === source ? null : source)}
            >
              <CardContent className="p-2 text-center">
                <div className="text-lg font-bold">{stats.bySource[source]}</div>
                <div className="text-xs text-muted-foreground">{source}</div>
              </CardContent>
            </Card>
          ))}
          <Card className={stats.errors > 0 ? 'border-red-300 dark:border-red-700' : ''}>
            <CardContent className="p-2 text-center">
              <div className={`text-lg font-bold ${stats.errors > 0 ? 'text-red-500' : ''}`}>
                {stats.errors}/{stats.warnings}
              </div>
              <div className="text-xs text-muted-foreground">错误/警告</div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 日志列表 */}
      <ScrollArea className="flex-1 p-3" ref={scrollRef}>
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
            <FileText className="w-12 h-12 mb-2 opacity-30" />
            <p>暂无 PDF 多模态日志</p>
            <p className="text-xs mt-1">上传 PDF 并选择图片模式后将在此显示调试信息</p>
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

      {/* 使用说明 */}
      <div className="p-3 border-t bg-muted/30">
        <div className="text-xs text-muted-foreground">
          <p><strong>关键日志标识：</strong></p>
          <p>[PDF_DEBUG_FE] - 前端解析日志 | [FileDefinition] - 格式化日志 | multimodalBlocks - 多模态内容块</p>
          <p className="mt-1"><strong>检查要点：</strong> 1) isMultimodal 必须为 true 2) includeImage 必须为 true 3) multimodalBlocks 必须有内容</p>
        </div>
      </div>
    </div>
  );
};

// 插件元数据
export const pluginMeta = {
  id: 'pdf-multimodal-debug',
  name: 'PDF 多模态调试',
  description: '调试 PDF 图片模式注入问题',
  icon: ImageIcon,
};

export default PdfMultimodalDebugPlugin;
