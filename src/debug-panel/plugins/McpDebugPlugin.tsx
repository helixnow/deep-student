import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Copy, FloppyDisk, Funnel, HardDrives, Clock } from '@phosphor-icons/react';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { EVENT_TYPE_ICONS, EVENT_TYPE_LABELS, LEVEL_COLORS, LEVEL_ICONS, type LogLevel, type McpEventType, type McpLog } from './mcp/model';
import { LogThrottler, sanitizeDetails, truncateData } from './mcp/sanitize';

const McpDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const { t } = useTranslation('common');
  
  const [logs, setLogs] = React.useState<McpLog[]>([]);
  const [selectedServer, setSelectedServer] = React.useState<string>('all');
  const [selectedType, setSelectedType] = React.useState<McpEventType | 'all'>('all');
  const [selectedLevel, setSelectedLevel] = React.useState<LogLevel | 'all'>('all');
  const [keyword, setKeyword] = React.useState('');
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [throttleEnabled, setThrottleEnabled] = React.useState(true);
  
  const throttler = React.useRef(new LogThrottler());
  const logContainerRef = React.useRef<HTMLDivElement>(null);
  const activeServers = React.useRef(new Set<string>());

  const throttleEnabledRef = React.useRef(throttleEnabled);
  
  // 使用 ref 避免 append 函数因 throttleEnabled 变化而重新创建
  React.useEffect(() => {
    throttleEnabledRef.current = throttleEnabled;
  }, [throttleEnabled]);
  
  const append = React.useCallback((entry: Omit<McpLog, 'id'>) => {
    // 节流检查（仅对高频事件）
    if (throttleEnabledRef.current && (entry.type === 'stdio_message_send' || entry.type === 'stdio_message_recv')) {
      const throttleKey = `${entry.serverId}-${entry.type}`;
      if (!throttler.current.shouldLog(throttleKey)) {
        return; // 跳过此次日志
      }
    }
    
    setLogs(prev => {
      const next = [...prev, { ...entry, id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }];
      return next.slice(-2000); // 保留最近2000条
    });
    
    if (entry.serverId) {
      activeServers.current.add(entry.serverId);
    }
  }, []); // 不再依赖 throttleEnabled

  // 监听MCP配置初始化和变更
  React.useEffect(() => {
    if (!isActivated) return;

    const handleConfigInit = (event: CustomEvent) => {
      const { servers } = event.detail || {};
      append({
        ts: Date.now(),
        type: 'config_init',
        level: 'info',
        message: `MCP配置初始化，共 ${servers?.length || 0} 个服务器`,
        details: { 
          servers: servers?.map((s: any) => ({ 
            id: s.id, 
            type: s.type, 
            namespace: s.namespace 
            // 不包含 URL、env 等敏感信息
          })) 
        },
      });
    };

    const handleConfigChange = (event: CustomEvent) => {
      append({
        ts: Date.now(),
        type: 'config_change',
        level: 'info',
        message: 'MCP配置已更新',
        details: truncateData(event.detail),
      });
    };

    window.addEventListener('mcp-config-init' as any, handleConfigInit);
    window.addEventListener('mcp-config-change' as any, handleConfigChange);

    return () => {
      window.removeEventListener('mcp-config-init' as any, handleConfigInit);
      window.removeEventListener('mcp-config-change' as any, handleConfigChange);
    };
  }, [isActivated, append]);

  // 监听连接状态
  React.useEffect(() => {
    if (!isActivated) return;

    const handleConnectStart = (event: CustomEvent) => {
      const { serverId, transport } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        type: 'connect_start',
        level: 'info',
        message: `开始连接服务器: ${serverId} (${transport})`,
        details: { transport },
      });
    };

    const handleConnectSuccess = (event: CustomEvent) => {
      const { serverId, transport } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        type: 'connect_success',
        level: 'success',
        message: `连接成功: ${serverId}`,
        details: { transport },
      });
    };

    const handleConnectFail = (event: CustomEvent) => {
      const { serverId, error, transport } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        type: 'connect_fail',
        level: 'error',
        message: `连接失败: ${serverId}`,
        details: { transport, error: truncateData(error) },
      });
    };

    const handleDisconnect = (event: CustomEvent) => {
      const { serverId } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        type: 'disconnect',
        level: 'warning',
        message: `断开连接: ${serverId}`,
      });
    };

    window.addEventListener('mcp-connect-start' as any, handleConnectStart);
    window.addEventListener('mcp-connect-success' as any, handleConnectSuccess);
    window.addEventListener('mcp-connect-fail' as any, handleConnectFail);
    window.addEventListener('mcp-disconnect' as any, handleDisconnect);

    return () => {
      window.removeEventListener('mcp-connect-start' as any, handleConnectStart);
      window.removeEventListener('mcp-connect-success' as any, handleConnectSuccess);
      window.removeEventListener('mcp-connect-fail' as any, handleConnectFail);
      window.removeEventListener('mcp-disconnect' as any, handleDisconnect);
    };
  }, [isActivated, append]);

  // 监听Stdio消息收发
  React.useEffect(() => {
    if (!isActivated) return;

    const handleStdioSend = (event: CustomEvent) => {
      const { sessionId, serverId, payload } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        sessionId,
        type: 'stdio_message_send',
        level: 'debug',
        message: `Stdio发送消息`,
        details: { payload: truncateData(payload, 300) },
      });
    };

    const handleStdioRecv = (event: CustomEvent) => {
      const { sessionId, serverId, payload } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        sessionId,
        type: 'stdio_message_recv',
        level: 'debug',
        message: `Stdio接收消息`,
        details: { payload: truncateData(payload, 300) },
      });
    };

    const handleStdioError = (event: CustomEvent) => {
      const { sessionId, serverId, error } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        sessionId,
        type: 'stdio_error',
        level: 'error',
        message: `Stdio错误`,
        details: { error: truncateData(error) },
      });
    };

    const handleStdioClosed = (event: CustomEvent) => {
      const { sessionId, serverId } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        sessionId,
        type: 'stdio_closed',
        level: 'warning',
        message: `Stdio连接关闭`,
      });
    };

    window.addEventListener('mcp-stdio-send' as any, handleStdioSend);
    window.addEventListener('mcp-stdio-recv' as any, handleStdioRecv);
    window.addEventListener('mcp-stdio-error' as any, handleStdioError);
    window.addEventListener('mcp-stdio-closed' as any, handleStdioClosed);

    return () => {
      window.removeEventListener('mcp-stdio-send' as any, handleStdioSend);
      window.removeEventListener('mcp-stdio-recv' as any, handleStdioRecv);
      window.removeEventListener('mcp-stdio-error' as any, handleStdioError);
      window.removeEventListener('mcp-stdio-closed' as any, handleStdioClosed);
    };
  }, [isActivated, append]);

  // 监听工具调用
  React.useEffect(() => {
    if (!isActivated) return;

    const handleToolCallStart = (event: CustomEvent) => {
      const { serverId, toolName, args, callId } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        type: 'tool_call_start',
        level: 'info',
        message: `调用工具: ${toolName}`,
        details: { toolName, toolArgs: truncateData(args), callId },
      });
    };

    const handleToolCallSuccess = (event: CustomEvent) => {
      const { serverId, toolName, result, duration, callId } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        type: 'tool_call_success',
        level: 'success',
        message: `工具成功: ${toolName} (${duration}ms)`,
        details: { toolName, toolResult: truncateData(result), duration, callId },
      });
    };

    const handleToolCallError = (event: CustomEvent) => {
      const { serverId, toolName, error, duration, callId } = event.detail || {};
      append({
        ts: Date.now(),
        serverId,
        type: 'tool_call_error',
        level: 'error',
        message: `工具错误: ${toolName}`,
        details: { toolName, error: truncateData(error), duration, callId },
      });
    };

    window.addEventListener('mcp-tool-call-start' as any, handleToolCallStart);
    window.addEventListener('mcp-tool-call-success' as any, handleToolCallSuccess);
    window.addEventListener('mcp-tool-call-error' as any, handleToolCallError);

    return () => {
      window.removeEventListener('mcp-tool-call-start' as any, handleToolCallStart);
      window.removeEventListener('mcp-tool-call-success' as any, handleToolCallSuccess);
      window.removeEventListener('mcp-tool-call-error' as any, handleToolCallError);
    };
  }, [isActivated, append]);

  // 自动滚动到底部
  React.useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = React.useCallback(() => {
    setLogs([]);
    activeServers.current.clear();
    throttler.current.clear(); // 清理节流器内存
  }, []);

  const exportLogs = React.useCallback(() => {
    const data = JSON.stringify(logs.map(l => ({
      ...l,
      timestamp: new Date(l.ts).toISOString(),
      details: sanitizeDetails(l.details),
    })), null, 2);
    
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mcp-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  const filteredLogs = React.useMemo(() => {
    return logs.filter(log => {
      if (errorsOnly && log.level !== 'error' && log.level !== 'warning') return false;
      if (selectedServer !== 'all' && log.serverId !== selectedServer) return false;
      if (selectedType !== 'all' && log.type !== selectedType) return false;
      if (selectedLevel !== 'all' && log.level !== selectedLevel) return false;
      if (keyword && !JSON.stringify(log).toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }, [logs, errorsOnly, selectedServer, selectedType, selectedLevel, keyword]);

  const copyLog = React.useCallback((log: McpLog) => {
    const text = JSON.stringify({
      timestamp: new Date(log.ts).toISOString(),
      serverId: log.serverId,
      sessionId: log.sessionId,
      type: log.type,
      level: log.level,
      message: log.message,
      details: sanitizeDetails(log.details),
    }, null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', '日志已复制到剪贴板');
    }).catch(console.error);
  }, []);

  const copyAllLogs = React.useCallback(() => {
    const text = JSON.stringify(filteredLogs.map(log => ({
      timestamp: new Date(log.ts).toISOString(),
      serverId: log.serverId,
      sessionId: log.sessionId,
      type: log.type,
      level: log.level,
      message: log.message,
      details: sanitizeDetails(log.details),
    })), null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', `已复制 ${filteredLogs.length} 条日志到剪贴板`);
    }).catch(console.error);
  }, [filteredLogs]);

  const stats = React.useMemo(() => {
    const counts: Record<string, number> = { debug: 0, info: 0, success: 0, warning: 0, error: 0 };
    const serverStats: Record<string, number> = {};
    const typeStats: Record<string, number> = {};
    
    logs.forEach(log => {
      counts[log.level]++;
      if (log.serverId) {
        serverStats[log.serverId] = (serverStats[log.serverId] || 0) + 1;
      }
      typeStats[log.type] = (typeStats[log.type] || 0) + 1;
    });
    
    return { counts, serverStats, typeStats };
  }, [logs]);

  if (!isActivated) return null;

  const allServers = Array.from(activeServers.current);

  return (
    <div className="p-4 space-y-4 h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-4 flex-shrink-0">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <HardDrives size={20} />
          MCP 调试
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setThrottleEnabled(!throttleEnabled)}
            className={`px-3 py-1 text-sm rounded flex items-center gap-1 [@media(pointer:coarse)]:min-h-11 ${throttleEnabled ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title={throttleEnabled ? '节流已启用（防日志风暴）' : '节流已禁用'}
          >
            <Clock size={16} />
            {throttleEnabled ? '节流' : '无节流'}
          </button>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-3 py-1 text-sm rounded [@media(pointer:coarse)]:min-h-11 ${autoScroll ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title="自动滚动到底部"
          >
            自动滚动
          </button>
          <button
            onClick={() => setErrorsOnly(!errorsOnly)}
            className={`px-3 py-1 text-sm rounded [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 ${errorsOnly ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title="仅显示错误和警告"
          >
            <Funnel size={16} />
          </button>
          <button
            onClick={copyAllLogs}
            className="px-3 py-1 text-sm bg-purple-500 text-white rounded hover:bg-purple-600 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            disabled={filteredLogs.length === 0}
            title="复制所有日志到剪贴板"
          >
            <Copy size={16} />
          </button>
          <button
            onClick={exportLogs}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            disabled={logs.length === 0}
            title="导出日志为JSON文件"
          >
            <FloppyDisk size={16} />
          </button>
          <button
            onClick={clearLogs}
            className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600 [@media(pointer:coarse)]:min-h-11"
            title="清空日志"
          >
            清空
          </button>
        </div>
      </div>

      {/* 统计面板 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 flex-shrink-0">
        <div className="p-3 bg-gray-100 rounded">
          <div className="text-xs text-gray-500">调试</div>
          <div className="text-lg font-semibold text-gray-600">{stats.counts.debug}</div>
        </div>
        <div className="p-3 bg-blue-100 rounded">
          <div className="text-xs text-blue-600">信息</div>
          <div className="text-lg font-semibold text-blue-700">{stats.counts.info}</div>
        </div>
        <div className="p-3 bg-green-100 rounded">
          <div className="text-xs text-green-600">成功</div>
          <div className="text-lg font-semibold text-green-700">{stats.counts.success}</div>
        </div>
        <div className="p-3 bg-yellow-100 rounded">
          <div className="text-xs text-yellow-600">警告</div>
          <div className="text-lg font-semibold text-yellow-700">{stats.counts.warning}</div>
        </div>
        <div className="p-3 bg-red-100 rounded">
          <div className="text-xs text-red-600">错误</div>
          <div className="text-lg font-semibold text-red-700">{stats.counts.error}</div>
        </div>
      </div>

      {/* 过滤器 */}
      <div className="flex flex-wrap gap-3 flex-shrink-0">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-gray-600 mb-1">搜索关键词</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索消息、服务器ID..."
            className="w-full px-3 py-1.5 text-sm [@media(pointer:coarse)]:text-[16px] border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 [@media(pointer:coarse)]:min-h-11"
          />
        </div>
        
        <div className="min-w-[180px]">
          <label className="block text-xs text-gray-600 mb-1">服务器</label>
          <select
            value={selectedServer}
            onChange={(e) => setSelectedServer(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 [@media(pointer:coarse)]:min-h-11"
          >
            <option value="all">全部服务器 ({allServers.length})</option>
            {allServers.map(serverId => (
              <option key={serverId} value={serverId}>
                {serverId} ({stats.serverStats[serverId] || 0})
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-[150px]">
          <label className="block text-xs text-gray-600 mb-1">事件类型</label>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as any)}
            className="w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 [@media(pointer:coarse)]:min-h-11"
          >
            <option value="all">全部类型</option>
            {Object.entries(EVENT_TYPE_LABELS).map(([type, label]) => (
              <option key={type} value={type}>
                {label} ({stats.typeStats[type] || 0})
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-[120px]">
          <label className="block text-xs text-gray-600 mb-1">日志级别</label>
          <select
            value={selectedLevel}
            onChange={(e) => setSelectedLevel(e.target.value as any)}
            className="w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 [@media(pointer:coarse)]:min-h-11"
          >
            <option value="all">全部级别</option>
            <option value="debug">调试</option>
            <option value="info">信息</option>
            <option value="success">成功</option>
            <option value="warning">警告</option>
            <option value="error">错误</option>
          </select>
        </div>
      </div>

      {/* 日志列表 */}
      <div className="border rounded-lg overflow-hidden flex-1 flex flex-col min-h-0">
        <div className="bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 flex items-center justify-between flex-shrink-0">
          <span>日志记录 ({filteredLogs.length} / {logs.length})</span>
          {filteredLogs.length === 0 && logs.length > 0 && (
            <span className="text-xs text-gray-500">没有匹配的日志</span>
          )}
        </div>
        
        <div 
          ref={logContainerRef}
          className="flex-1 overflow-auto"
        >
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              {logs.length === 0 ? '暂无日志记录。MCP操作将自动记录在此。' : '没有符合过滤条件的日志'}
            </div>
          ) : (
            <div className="divide-y">
              {filteredLogs.map((log) => {
                const Icon = LEVEL_ICONS[log.level];
                const EventIcon = EVENT_TYPE_ICONS[log.type];
                return (
                  <div key={log.id} className="p-3 hover:bg-gray-50">
                    <div className="flex items-start gap-3">
                      <Icon 
                        size={20} className="mt-0.5 flex-shrink-0" 
                        style={{ color: LEVEL_COLORS[log.level] }}
                      />
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs text-gray-500">
                            {new Date(log.ts).toLocaleTimeString(undefined, { 
                              hour12: false, 
                              hour: '2-digit', 
                              minute: '2-digit', 
                              second: '2-digit'
                            })}.{String(log.ts % 1000).padStart(3, '0')}
                          </span>
                          <span className="px-2 py-0.5 text-xs rounded" style={{ 
                            backgroundColor: `${LEVEL_COLORS[log.level]}20`,
                            color: LEVEL_COLORS[log.level]
                          }}>
                            {log.level.toUpperCase()}
                          </span>
                          {log.serverId && (
                            <span className="px-2 py-0.5 text-xs bg-gray-200 text-gray-700 rounded">
                              {log.serverId}
                            </span>
                          )}
                          <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded flex items-center gap-1">
                            <EventIcon size={12} />
                            {EVENT_TYPE_LABELS[log.type]}
                          </span>
                          {log.sessionId && (
                            <span className="px-2 py-0.5 text-xs bg-purple-100 text-purple-700 rounded">
                              Session: {log.sessionId.slice(0, 8)}
                            </span>
                          )}
                        </div>
                        
                        <div className="text-sm text-gray-800 mb-1">
                          {log.message}
                        </div>
                        
                        {log.details && Object.keys(log.details).length > 0 && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-gray-600 hover:text-gray-800 [@media(pointer:coarse)]:min-h-11">
                              查看详细信息
                            </summary>
                            <pre className="mt-2 p-2 bg-gray-100 rounded overflow-auto text-xs">
                              {JSON.stringify(sanitizeDetails(log.details), null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                      
                      <button
                        onClick={() => copyLog(log)}
                        className="p-1 text-gray-400 hover:text-gray-600 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                        title="复制日志"
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default McpDebugPlugin;
