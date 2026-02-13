import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface ThinkingChainDebugPluginProps {
  visible: boolean;
  isActive: boolean;
  isActivated: boolean;
  onClose: () => void;
  currentStreamId?: string;
}

interface ThinkingChainLog {
  id: string;
  timestamp: number;
  level: 'log' | 'warn' | 'error' | 'info';
  prefix: string;
  message: string;
  data?: any;
  rawArgs: any[];
}

const MAX_LOGS = 2000;
const THINKING_CHAIN_PREFIXES = [
  '[思维链解析]',
  '[思维链传递]',
  '[思维链Map]',
  '[思维链提取]',
  '[思维链渲染]',
  '[CompatRuntime]',
  '[StreamResponseMonitor]',
];

const ThinkingChainDebugPlugin: React.FC<ThinkingChainDebugPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const { t } = useTranslation('common');
  const [logs, setLogs] = useState<ThinkingChainLog[]>([]);
  const [filterPrefix, setFilterPrefix] = useState<string>('all');
  const [filterLevel, setFilterLevel] = useState<'all' | 'log' | 'warn' | 'error' | 'info'>('all');
  const [keyword, setKeyword] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copySuccess, setCopySuccess] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const originalConsoleRef = useRef<{
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
    info: typeof console.info;
  } | null>(null);

  const appendLog = useCallback((log: ThinkingChainLog) => {
    setLogs((prev) => {
      const next = [...prev, log];
      if (next.length > MAX_LOGS) {
        return next.slice(-MAX_LOGS);
      }
      return next;
    });
  }, []);

  // 拦截 console 方法
  useEffect(() => {
    if (!isActivated) {
      // 恢复原始 console
      if (originalConsoleRef.current) {
        console.log = originalConsoleRef.current.log;
        console.warn = originalConsoleRef.current.warn;
        console.error = originalConsoleRef.current.error;
        console.info = originalConsoleRef.current.info;
        originalConsoleRef.current = null;
      }
      return;
    }

    // 保存原始 console 方法
    originalConsoleRef.current = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
    };

    // 拦截 console.log
    const interceptConsole = (
      level: 'log' | 'warn' | 'error' | 'info',
      originalFn: typeof console.log
    ) => {
      return (...args: any[]) => {
        // 先调用原始方法
        originalFn(...args);

        // 检查是否包含思维链相关前缀
        const firstArg = args[0];
        if (typeof firstArg === 'string') {
          const matchedPrefix = THINKING_CHAIN_PREFIXES.find((prefix) =>
            firstArg.startsWith(prefix)
          );

          if (matchedPrefix) {
            const message = firstArg.replace(matchedPrefix, '').trim();
            const data = args.length > 1 ? args.slice(1) : undefined;

            appendLog({
              id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
              timestamp: Date.now(),
              level,
              prefix: matchedPrefix,
              message,
              data: data && data.length === 1 ? data[0] : data,
              rawArgs: args,
            });
          }
        } else if (args.length > 0) {
          // 检查 args 中是否有字符串包含前缀
          const argStr = JSON.stringify(args);
          const matchedPrefix = THINKING_CHAIN_PREFIXES.find((prefix) =>
            argStr.includes(prefix)
          );

          if (matchedPrefix) {
            appendLog({
              id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
              timestamp: Date.now(),
              level,
              prefix: matchedPrefix,
              message: argStr.slice(0, 200) + (argStr.length > 200 ? '...' : ''),
              data: args.length === 1 ? args[0] : args,
              rawArgs: args,
            });
          }
        }
      };
    };

    console.log = interceptConsole('log', originalConsoleRef.current.log);
    console.warn = interceptConsole('warn', originalConsoleRef.current.warn);
    console.error = interceptConsole('error', originalConsoleRef.current.error);
    console.info = interceptConsole('info', originalConsoleRef.current.info);

    return () => {
      // 恢复原始 console
      if (originalConsoleRef.current) {
        console.log = originalConsoleRef.current.log;
        console.warn = originalConsoleRef.current.warn;
        console.error = originalConsoleRef.current.error;
        console.info = originalConsoleRef.current.info;
        originalConsoleRef.current = null;
      }
    };
  }, [isActivated, appendLog]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // 过滤日志
  const filteredLogs = React.useMemo(() => {
    return logs.filter((log) => {
      if (filterPrefix !== 'all' && log.prefix !== filterPrefix) return false;
      if (filterLevel !== 'all' && log.level !== filterLevel) return false;
      if (keyword) {
        const searchText = `${log.message} ${JSON.stringify(log.data || {})}`.toLowerCase();
        if (!searchText.includes(keyword.toLowerCase())) return false;
      }
      return true;
    });
  }, [logs, filterPrefix, filterLevel, keyword]);

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    return `${date.toLocaleTimeString()}.${date.getMilliseconds().toString().padStart(3, '0')}`;
  };

  const formatData = (data: any): string => {
    if (data === undefined || data === null) return '';
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const copyLogs = async () => {
    if (filteredLogs.length === 0) {
      return;
    }

    const formatLog = (log: ThinkingChainLog): string => {
      const timestamp = formatTimestamp(log.timestamp);
      const dataStr = log.data ? `\n${formatData(log.data)}` : '';
      return `[${timestamp}] ${log.prefix} [${log.level.toUpperCase()}]\n${log.message}${dataStr}\n${'='.repeat(80)}\n`;
    };

    const logText = filteredLogs.map(formatLog).join('\n');
    const header = `思维链调试日志\n生成时间: ${new Date().toLocaleString()}\n总日志数: ${logs.length}\n显示日志数: ${filteredLogs.length}\n过滤器: 前缀=${filterPrefix}, 级别=${filterLevel}, 关键词=${keyword || '无'}\n${'='.repeat(80)}\n\n`;
    const fullText = header + logText;

    try {
      await navigator.clipboard.writeText(fullText);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('复制失败:', error);
      // 降级方案：使用临时 textarea
      const textarea = document.createElement('textarea');
      textarea.value = fullText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } catch (e) {
        console.error('降级复制也失败:', e);
      }
      document.body.removeChild(textarea);
    }
  };

  const getLevelColor = (level: ThinkingChainLog['level']) => {
    switch (level) {
      case 'error':
        return '#ef4444';
      case 'warn':
        return '#f59e0b';
      case 'info':
        return '#3b82f6';
      default:
        return '#e2e8f0';
    }
  };

  const getPrefixColor = (prefix: string) => {
    if (prefix.includes('解析')) return '#10b981';
    if (prefix.includes('传递')) return '#3b82f6';
    if (prefix.includes('Map')) return '#8b5cf6';
    if (prefix.includes('提取')) return '#f59e0b';
    if (prefix.includes('渲染')) return '#ec4899';
    if (prefix.includes('CompatRuntime')) return '#06b6d4';
    if (prefix.includes('StreamResponseMonitor')) return '#6366f1';
    return '#94a3b8';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* 工具栏 */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid #1e293b',
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={clearLogs}
          style={{
            fontSize: 12,
            color: '#e2e8f0',
            background: '#334155',
            border: '1px solid #475569',
            borderRadius: 4,
            padding: '4px 8px',
            cursor: 'pointer',
          }}
        >
          清空
        </button>
        <button
          onClick={copyLogs}
          disabled={filteredLogs.length === 0}
          style={{
            fontSize: 12,
            color: filteredLogs.length === 0 ? '#64748b' : '#e2e8f0',
            background: copySuccess ? '#10b981' : '#334155',
            border: '1px solid #475569',
            borderRadius: 4,
            padding: '4px 8px',
            cursor: filteredLogs.length === 0 ? 'not-allowed' : 'pointer',
            opacity: filteredLogs.length === 0 ? 0.5 : 1,
            transition: 'background-color 0.2s',
          }}
        >
          {copySuccess ? '✓ 已复制' : '复制日志'}
        </button>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: '#cbd5e1',
          }}
        >
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ width: 14, height: 14 }}
          />
          自动滚动
        </label>
        <div style={{ flexGrow: 1 }} />
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          总日志: {logs.length} | 显示: {filteredLogs.length}
        </span>
      </div>

      {/* 过滤器 */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid #1e293b',
          flexWrap: 'wrap',
        }}
      >
        <label style={{ fontSize: 12, color: '#cbd5e1' }}>前缀:</label>
        <select
          value={filterPrefix}
          onChange={(e) => setFilterPrefix(e.target.value)}
          style={{
            fontSize: 12,
            background: '#334155',
            color: '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          <option value="all">全部</option>
          {THINKING_CHAIN_PREFIXES.map((prefix) => (
            <option key={prefix} value={prefix}>
              {prefix}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: '#cbd5e1' }}>级别:</label>
        <select
          value={filterLevel}
          onChange={(e) => setFilterLevel(e.target.value as any)}
          style={{
            fontSize: 12,
            background: '#334155',
            color: '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          <option value="all">全部</option>
          <option value="log">Log</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <label style={{ fontSize: 12, color: '#cbd5e1' }}>关键词:</label>
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索..."
          style={{
            fontSize: 12,
            background: '#334155',
            color: '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: 4,
            padding: '4px 8px',
            minWidth: 150,
          }}
        />
      </div>

      {/* 日志列表 */}
      <div
        ref={logContainerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
          lineHeight: 1.6,
          background: '#0b1220',
          color: '#e2e8f0',
        }}
      >
        {filteredLogs.length === 0 ? (
          <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px 20px' }}>
            {logs.length === 0
              ? '等待思维链日志...开始一次对话以查看日志。'
              : '没有匹配的日志。'}
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div
              key={log.id}
              style={{
                marginBottom: '12px',
                padding: '8px 12px',
                background: '#1e293b',
                border: '1px solid #334155',
                borderRadius: 4,
                borderLeft: `3px solid ${getPrefixColor(log.prefix)}`,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: '4px' }}>
                <span
                  style={{
                    color: getPrefixColor(log.prefix),
                    fontWeight: 600,
                    fontSize: 11,
                  }}
                >
                  {log.prefix}
                </span>
                <span
                  style={{
                    color: getLevelColor(log.level),
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  {log.level.toUpperCase()}
                </span>
                <span style={{ color: '#64748b', fontSize: 11 }}>
                  {formatTimestamp(log.timestamp)}
                </span>
              </div>
              <div style={{ color: '#e2e8f0', marginBottom: log.data ? '8px' : 0 }}>
                {log.message}
              </div>
              {log.data && (
                <details
                  style={{
                    marginTop: '8px',
                    padding: '8px',
                    background: '#0f172a',
                    borderRadius: 4,
                    border: '1px solid #334155',
                  }}
                >
                  <summary
                    style={{
                      cursor: 'pointer',
                      color: '#94a3b8',
                      fontSize: 11,
                      marginBottom: '4px',
                    }}
                  >
                    查看详情
                  </summary>
                  <pre
                    style={{
                      margin: 0,
                      color: '#cbd5e1',
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: '300px',
                      overflow: 'auto',
                    }}
                  >
                    {formatData(log.data)}
                  </pre>
                </details>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default ThinkingChainDebugPlugin;
