import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Copy, FloppyDisk, Warning, CheckCircle, XCircle, Funnel, Upload, ArrowSquareOut, FileText, Clipboard, Chat } from '@phosphor-icons/react';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

type LogLevel = 'debug' | 'info' | 'warning' | 'error';
type DragDropStage = 
  | 'drag_enter' 
  | 'drag_over' 
  | 'drag_leave' 
  | 'drop_received'
  | 'validation_start'
  | 'validation_passed'
  | 'validation_failed'
  | 'file_processing'
  | 'file_converted'
  | 'callback_invoked'
  | 'callback_error'
  | 'complete';

interface DragDropLog {
  id: string;
  ts: number;
  zoneId: string;
  stage: DragDropStage;
  level: LogLevel;
  message: string;
  details?: {
    fileNames?: string[];
    filePaths?: string[];
    fileCount?: number;
    acceptedTypes?: string[];
    rejectedFiles?: string[];
    errorMessage?: string;
    validationErrors?: string[];
    processingTime?: number;
    [key: string]: any;
  };
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',
};

const LEVEL_ICONS: Record<LogLevel, React.FC<any>> = {
  debug: Upload,
  info: CheckCircle,
  warning: Warning,
  error: XCircle,
};

const STAGE_LABELS: Record<DragDropStage, string> = {
  drag_enter: '拖拽进入',
  drag_over: '拖拽悬停',
  drag_leave: '拖拽离开',
  drop_received: '接收文件',
  validation_start: '开始验证',
  validation_passed: '验证通过',
  validation_failed: '验证失败',
  file_processing: '处理文件',
  file_converted: '转换完成',
  callback_invoked: '回调执行',
  callback_error: '回调错误',
  complete: '完成',
};

// 拖拽区域映射表
interface ZoneInfo {
  name: string;
  description: string;
  icon: React.FC<any>;
  navigationEvent?: string; // 导航事件名称
  tabName?: string; // 用于切换标签页的名称
}

// 实际在浮动导航入口使用的拖拽区域
const ZONE_MAPPING: Record<string, ZoneInfo> = {
  'anki-upload': {
    name: 'Anki 卡片生成',
    description: '上传文档生成 Anki 卡片',
    icon: FileText,
    tabName: 'anki',
  },
  // 聊天输入框（动态 zoneId，使用前缀匹配）
  'smart-input-landing': {
    name: '聊天输入框（首页）',
    description: '上传图片/文档到分析页面',
    icon: Chat,
    tabName: 'analysis',
  },
  'smart-input-docked': {
    name: '聊天输入框（对话中）',
    description: '上传图片/文档继续对话',
    icon: Chat,
    tabName: 'analysis',
  },
};

// 动态 zoneId 匹配函数（用于处理 chat-input-{businessId} 等动态ID）
const getZoneInfo = (zoneId: string): ZoneInfo => {
  // 精确匹配
  if (ZONE_MAPPING[zoneId]) return ZONE_MAPPING[zoneId];
  
  // 前缀匹配：chat-input-* 
  if (zoneId.startsWith('chat-input-')) {
    const suffix = zoneId.slice(11);
    const displayName = suffix === 'new' 
      ? '聊天输入框（新建会话）' 
      : suffix === 'legacy' 
        ? '聊天输入框（旧版/无ID）' 
        : `聊天输入框 (${suffix.slice(0, 8)})`;
    return {
      name: displayName,
      description: '上传图片/文档到分析对话',
      icon: Chat,
      tabName: 'analysis',
    };
  }
  
  // 未知区域
  return {
    name: zoneId,
    description: '未知区域',
    icon: Upload,
  };
};

// 快速导航函数
const navigateToZone = (zoneId: string) => {
  const zoneInfo = getZoneInfo(zoneId); // 使用动态匹配

  try {
    console.log(`[UnifiedDragDropDebug] 准备导航到: ${zoneInfo.name} (${zoneId})`);
    
    // 通过浮动导航栏切换（如果有 tabName）
    if (zoneInfo.tabName) {
      const event = new CustomEvent('navigate-to-tab', {
        detail: { tabName: zoneInfo.tabName },
      });
      window.dispatchEvent(event);
      console.log(`[UnifiedDragDropDebug] ✅ 已派发导航事件: ${zoneInfo.tabName}`);
      
      // 使用全局通知提示用户
      showGlobalNotification('info', `正在导航到：${zoneInfo.name}`);
    }
    
    // 方案2: 如果有自定义导航事件（保留扩展性）
    if (zoneInfo.navigationEvent) {
      const event = new CustomEvent(zoneInfo.navigationEvent);
      window.dispatchEvent(event);
      console.log(`[UnifiedDragDropDebug] ✅ 已派发自定义事件: ${zoneInfo.navigationEvent}`);
    }
    
    if (!zoneInfo.tabName && !zoneInfo.navigationEvent) {
      console.warn(`[UnifiedDragDropDebug] ⚠️ 区域 ${zoneId} 未配置导航方式`);
    }
  } catch (e) {
    console.error('[UnifiedDragDropDebug] ❌ 导航失败:', e);
  }
};

const sanitizeDetails = (details: any): any => {
  if (!details) return details;
  const MAX_INLINE = 300;
  const result: any = {};
  
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' && value.length > MAX_INLINE) {
      result[key] = `[${value.length} chars]`;
    } else if (Array.isArray(value) && value.length > 10) {
      result[key] = [...value.slice(0, 10), `... +${value.length - 10} more`];
    } else {
      result[key] = value;
    }
  }
  
  return result;
};

const UnifiedDragDropDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const { t } = useTranslation('common');
  
  const [logs, setLogs] = React.useState<DragDropLog[]>([]);
  const [selectedZone, setSelectedZone] = React.useState<string>('all');
  const [selectedLevel, setSelectedLevel] = React.useState<LogLevel | 'all'>('all');
  const [keyword, setKeyword] = React.useState('');
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [activeZones, setActiveZones] = React.useState<Set<string>>(new Set());
  
  // 预加载所有已知的拖拽区域（不需要等待事件）
  const allKnownZones = React.useMemo(() => Object.keys(ZONE_MAPPING), []);
  
  const append = React.useCallback((entry: Omit<DragDropLog, 'id'>) => {
    setLogs(prev => {
      const next = [...prev, { ...entry, id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }];
      return next.slice(-1000); // 保留最近1000条
    });
    setActiveZones(prev => new Set(prev).add(entry.zoneId));
  }, []);

  // 监听自定义事件
  React.useEffect(() => {
    if (!isActivated) return;

    const handleDragDropDebug = (event: CustomEvent<Omit<DragDropLog, 'id' | 'ts'>>) => {
      append({
        ...event.detail,
        ts: Date.now(),
      });
    };

    window.addEventListener('unified-drag-drop-debug' as any, handleDragDropDebug);
    
    return () => {
      window.removeEventListener('unified-drag-drop-debug' as any, handleDragDropDebug);
    };
  }, [isActivated, append]);

  const clearLogs = React.useCallback(() => {
    setLogs([]);
    setActiveZones(new Set());
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
    a.download = `drag-drop-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  const filteredLogs = React.useMemo(() => {
    return logs.filter(log => {
      if (errorsOnly && log.level !== 'error' && log.level !== 'warning') return false;
      if (selectedZone !== 'all' && log.zoneId !== selectedZone) return false;
      if (selectedLevel !== 'all' && log.level !== selectedLevel) return false;
      if (keyword && !JSON.stringify(log).toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }, [logs, errorsOnly, selectedZone, selectedLevel, keyword]);

  const copyLog = React.useCallback((log: DragDropLog) => {
    const text = JSON.stringify({
      timestamp: new Date(log.ts).toISOString(),
      zoneId: log.zoneId,
      stage: log.stage,
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
      zoneId: log.zoneId,
      stage: log.stage,
      level: log.level,
      message: log.message,
      details: sanitizeDetails(log.details),
    })), null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', `已复制 ${filteredLogs.length} 条日志到剪贴板`);
    }).catch(console.error);
  }, [filteredLogs]);

  const stats = React.useMemo(() => {
    const counts: Record<string, number> = { debug: 0, info: 0, warning: 0, error: 0 };
    const zoneStats: Record<string, number> = {};
    
    logs.forEach(log => {
      counts[log.level]++;
      zoneStats[log.zoneId] = (zoneStats[log.zoneId] || 0) + 1;
    });
    
    return { counts, zoneStats };
  }, [logs]);

  if (!isActivated) return null;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Upload size={20} />
          统一拖拽组件调试
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setErrorsOnly(!errorsOnly)}
            className={`px-3 py-1 text-sm rounded ${errorsOnly ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title="仅显示错误和警告"
          >
            <Funnel size={16} />
          </button>
          <button
            onClick={copyAllLogs}
            className="px-3 py-1 text-sm bg-purple-500 text-white rounded hover:bg-purple-600"
            disabled={filteredLogs.length === 0}
            title="复制所有日志到剪贴板"
          >
            <Clipboard size={16} />
          </button>
          <button
            onClick={exportLogs}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
            disabled={logs.length === 0}
            title="导出日志为JSON文件"
          >
            <FloppyDisk size={16} />
          </button>
          <button
            onClick={clearLogs}
            className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
            title="清空日志"
          >
            清空
          </button>
        </div>
      </div>

      {/* 统计面板 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="p-3 bg-gray-100 rounded">
          <div className="text-xs text-gray-500">调试</div>
          <div className="text-lg font-semibold text-gray-600">{stats.counts.debug}</div>
        </div>
        <div className="p-3 bg-blue-100 rounded">
          <div className="text-xs text-blue-600">信息</div>
          <div className="text-lg font-semibold text-blue-700">{stats.counts.info}</div>
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

      {/* 快速跳转区域 - 始终显示所有已知区域 */}
      <div className="border rounded-lg p-3 bg-gradient-to-r from-blue-50 to-indigo-50">
        <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
          <ArrowSquareOut size={16} />
          快速跳转到拖拽区域
          <span className="text-xs text-gray-500 ml-auto">
            ({allKnownZones.length} 个区域可用)
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {allKnownZones.sort().map(zoneId => {
            const zoneInfo = getZoneInfo(zoneId); // 使用动态匹配
            const ZoneIcon = zoneInfo.icon;
            const logCount = stats.zoneStats[zoneId] || 0;
            const hasActivity = activeZones.has(zoneId);
            
            return (
              <button
                key={zoneId}
                onClick={() => navigateToZone(zoneId)}
                className={`flex items-start gap-2 p-2 border rounded transition-all text-left group ${
                  hasActivity 
                    ? 'bg-white border-gray-200 hover:border-blue-400 hover:bg-blue-50' 
                    : 'bg-gray-50 border-gray-200 hover:border-blue-300 hover:bg-blue-50'
                }`}
                title={`点击跳转到 ${zoneInfo.name}`}
              >
                <ZoneIcon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${
                  hasActivity 
                    ? 'text-gray-400 group-hover:text-blue-600' 
                    : 'text-gray-300 group-hover:text-blue-500'
                }`} />
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium truncate ${
                    hasActivity 
                      ? 'text-gray-800 group-hover:text-blue-700' 
                      : 'text-gray-600 group-hover:text-blue-700'
                  }`}>
                    {zoneInfo.name}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {zoneInfo.description}
                  </div>
                  <div className={`text-xs mt-0.5 flex items-center gap-1 ${
                    hasActivity ? 'text-gray-400' : 'text-gray-300'
                  }`}>
                    {hasActivity ? (
                      <>
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                        {logCount} 条日志
                      </>
                    ) : (
                      <span>未检测到活动</span>
                    )}
                  </div>
                </div>
                <ArrowSquareOut size={16} className="text-gray-300 group-hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            );
          })}
        </div>
      </div>

      {/* 过滤器 */}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-gray-600 mb-1">搜索关键词</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索消息、文件名..."
            className="w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        
        <div className="min-w-[200px]">
          <label className="block text-xs text-gray-600 mb-1">拖拽区域</label>
          <select
            value={selectedZone}
            onChange={(e) => setSelectedZone(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">全部区域 ({allKnownZones.length})</option>
            {allKnownZones.sort().map(zoneId => {
              const zoneInfo = getZoneInfo(zoneId); // 使用动态匹配
              const logCount = stats.zoneStats[zoneId] || 0;
              const hasActivity = activeZones.has(zoneId);
              return (
                <option key={zoneId} value={zoneId}>
                  {hasActivity ? '🟢 ' : '⚪ '}{zoneInfo.name} ({logCount})
                </option>
              );
            })}
          </select>
        </div>

        <div className="min-w-[150px]">
          <label className="block text-xs text-gray-600 mb-1">日志级别</label>
          <select
            value={selectedLevel}
            onChange={(e) => setSelectedLevel(e.target.value as any)}
            className="w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">全部级别</option>
            <option value="debug">调试</option>
            <option value="info">信息</option>
            <option value="warning">警告</option>
            <option value="error">错误</option>
          </select>
        </div>
      </div>

      {/* 日志列表 */}
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 flex items-center justify-between">
          <span>日志记录 ({filteredLogs.length} / {logs.length})</span>
          {filteredLogs.length === 0 && logs.length > 0 && (
            <span className="text-xs text-gray-500">没有匹配的日志</span>
          )}
        </div>
        
        <div className="max-h-[600px] overflow-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              {logs.length === 0 ? '暂无日志记录' : '没有符合过滤条件的日志'}
            </div>
          ) : (
            <div className="divide-y">
              {filteredLogs.map((log) => {
                const Icon = LEVEL_ICONS[log.level];
                return (
                  <div key={log.id} className="p-3 hover:bg-gray-50">
                    <div className="flex items-start gap-3">
                      <Icon 
                        size={20} className="mt-0.5 flex-shrink-0" 
                        style={{ color: LEVEL_COLORS[log.level] }}
                      />
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-gray-500">
                            {new Date(log.ts).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions)}
                          </span>
                          <span className="px-2 py-0.5 text-xs rounded" style={{ 
                            backgroundColor: `${LEVEL_COLORS[log.level]}20`,
                            color: LEVEL_COLORS[log.level]
                          }}>
                            {log.level.toUpperCase()}
                          </span>
                          <span className="px-2 py-0.5 text-xs bg-gray-200 text-gray-700 rounded">
                            {log.zoneId}
                          </span>
                          <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">
                            {STAGE_LABELS[log.stage] || log.stage}
                          </span>
                        </div>
                        
                        <div className="text-sm text-gray-800 mb-1">
                          {log.message}
                        </div>
                        
                        {log.details && Object.keys(log.details).length > 0 && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-gray-600 hover:text-gray-800">
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
                        className="p-1 text-gray-400 hover:text-gray-600"
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

export default UnifiedDragDropDebugPlugin;
