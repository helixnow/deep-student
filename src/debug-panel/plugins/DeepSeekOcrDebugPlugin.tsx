import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { useTauriEventListener } from '../../hooks/useTauriEventListener';
import { Copy, Search, Filter, AlertCircle, CheckCircle, Clock, FileText } from 'lucide-react';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type DeepSeekOcrLog = {
  id: string;
  ts: number;
  level: LogLevel;
  stage: string; // 'request' | 'response' | 'parse' | 'convert' | 'result'
  pageIndex?: number;
  message: string;
  data?: any;
};

const DeepSeekOcrDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const { t } = useTranslation('common');
  const { attach } = useTauriEventListener();

  const [logs, setLogs] = React.useState<DeepSeekOcrLog[]>([]);
  const [filterLevel, setFilterLevel] = React.useState<LogLevel | 'all'>('all');
  const [filterStage, setFilterStage] = React.useState<string>('all');
  const [keyword, setKeyword] = React.useState('');
  const [autoScroll, setAutoScroll] = React.useState(true);
  
  const logsEndRef = React.useRef<HTMLDivElement>(null);
  const seenEventsRef = React.useRef<Set<string>>(new Set());

  const append = React.useCallback((entry: Omit<DeepSeekOcrLog, 'id'>) => {
    setLogs(prev => {
      const next = [...prev, { 
        ...entry, 
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` 
      }];
      return next.slice(-1000); // 保留最近 1000 条
    });
  }, []);

  // 监听 Tauri 事件
  React.useEffect(() => {
    if (!isActivated) return;

    let unlistenFn: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlistenFn = await attach('deepseek_ocr_log', (event: any) => {
          const { level, stage, page_index, message, data } = event.payload || {};
          const key = `${Date.now()}-${stage}-${page_index}-${message}`;
          
          if (seenEventsRef.current.has(key)) return;
          seenEventsRef.current.add(key);
          
          if (seenEventsRef.current.size > 2000) {
            seenEventsRef.current.clear();
          }

          append({
            ts: Date.now(),
            level: level || 'info',
            stage: stage || 'unknown',
            pageIndex: page_index,
            message: message || '',
            data: data,
          });
        });
      } catch (error) {
        console.error('[DeepSeek-OCR-Debug] Failed to attach event listener:', error);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        try {
          unlistenFn();
        } catch (error) {
          console.error('[DeepSeek-OCR-Debug] Failed to unlisten:', error);
        }
      }
    };
  }, [isActivated, attach, append]);

  // 自动滚动
  React.useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const filteredLogs = React.useMemo(() => {
    return logs.filter(log => {
      if (filterLevel !== 'all' && log.level !== filterLevel) return false;
      if (filterStage !== 'all' && log.stage !== filterStage) return false;
      if (keyword && !JSON.stringify(log).toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }, [logs, filterLevel, filterStage, keyword]);

  const copyAll = () => {
    const text = filteredLogs.map(log => {
      const ts = new Date(log.ts).toLocaleTimeString();
      const page = log.pageIndex !== undefined ? ` [Page ${log.pageIndex}]` : '';
      const dataStr = log.data ? `\n${JSON.stringify(log.data, null, 2)}` : '';
      return `[${ts}]${page} [${log.level.toUpperCase()}] [${log.stage}] ${log.message}${dataStr}`;
    }).join('\n\n');
    
    copyTextToClipboard(text).then(() => {
      unifiedAlert('已复制 DeepSeek-OCR 日志到剪贴板');
    });
  };

  const clearLogs = () => {
    if (unifiedConfirm('确定清空所有 DeepSeek-OCR 日志？')) {
      setLogs([]);
      seenEventsRef.current.clear();
    }
  };

  const stages = ['all', 'init', 'request', 'response', 'parse', 'convert', 'result', 'error'];
  const levelColors = {
    debug: 'text-gray-500',
    info: 'text-blue-500',
    warn: 'text-yellow-500',
    error: 'text-red-500',
  };

  const levelIcons = {
    debug: <Search className="w-4 h-4" />,
    info: <CheckCircle className="w-4 h-4" />,
    warn: <AlertCircle className="w-4 h-4" />,
    error: <AlertCircle className="w-4 h-4" />,
  };

  if (!visible) return null;

  return (
    <div className="flex flex-col h-full bg-background text-foreground p-4 space-y-4">
      {/* 头部工具栏 */}
      <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-border">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-lg">DeepSeek-OCR 调试</h3>
        </div>
        
        <div className="flex-1" />
        
        {/* 过滤器 */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <select
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value as any)}
            className="px-2 py-1 text-sm rounded border border-border bg-background"
          >
            <option value="all">所有级别</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>

          <select
            value={filterStage}
            onChange={(e) => setFilterStage(e.target.value)}
            className="px-2 py-1 text-sm rounded border border-border bg-background"
          >
            {stages.map(s => (
              <option key={s} value={s}>{s === 'all' ? '所有阶段' : s}</option>
            ))}
          </select>

          <input
            type="text"
            placeholder="关键词搜索..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="px-2 py-1 text-sm rounded border border-border bg-background w-40"
          />
        </div>

        {/* 操作按钮 */}
        <label className="flex items-center gap-1 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded"
          />
          自动滚动
        </label>

        <button
          onClick={copyAll}
          className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Copy className="w-4 h-4" />
          复制全部
        </button>

        <button
          onClick={clearLogs}
          className="px-3 py-1 text-sm rounded border border-border hover:bg-muted"
        >
          清空
        </button>
      </div>

      {/* 统计信息 */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <div>总计: <span className="font-semibold text-foreground">{logs.length}</span></div>
        <div>显示: <span className="font-semibold text-foreground">{filteredLogs.length}</span></div>
        <div className="flex items-center gap-2">
          {(['debug', 'info', 'warn', 'error'] as LogLevel[]).map(level => {
            const count = logs.filter(l => l.level === level).length;
            if (count === 0) return null;
            return (
              <div key={level} className={`flex items-center gap-1 ${levelColors[level]}`}>
                {levelIcons[level]}
                <span>{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 日志列表 */}
      <div className="flex-1 overflow-auto space-y-2 font-mono text-xs">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Clock className="w-12 h-12 mb-2 opacity-50" />
            <p>等待 DeepSeek-OCR 调用...</p>
            <p className="text-xs mt-1">在题目集工作台选择 DeepSeek-OCR 格式并识别</p>
          </div>
        ) : (
          <>
            {filteredLogs.map((log) => {
              const ts = new Date(log.ts).toLocaleTimeString();
              return (
                <div
                  key={log.id}
                  className="p-2 rounded border border-border bg-card hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    {/* 时间戳和级别 */}
                    <div className="flex items-center gap-2 min-w-[140px]">
                      <span className="text-muted-foreground">{ts}</span>
                      <span className={`flex items-center gap-1 ${levelColors[log.level]}`}>
                        {levelIcons[log.level]}
                        <span className="font-semibold uppercase">{log.level}</span>
                      </span>
                    </div>

                    {/* 阶段和页码 */}
                    <div className="flex items-center gap-2 min-w-[120px]">
                      <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-xs font-semibold">
                        {log.stage}
                      </span>
                      {log.pageIndex !== undefined && (
                        <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-500 text-xs">
                          Page {log.pageIndex}
                        </span>
                      )}
                    </div>

                    {/* 消息 */}
                    <div className="flex-1 break-words">
                      <div className="font-semibold mb-1">{log.message}</div>
                      {log.data && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                            展开数据 ▼
                          </summary>
                          <pre className="mt-2 p-2 rounded bg-muted overflow-auto max-h-96 text-xs">
                            {JSON.stringify(log.data, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={logsEndRef} />
          </>
        )}
      </div>
    </div>
  );
};

export default DeepSeekOcrDebugPlugin;
