/**
 * 滚动区域调试插件
 * 全面监控 CustomScrollArea 与 ProseMirror 选区的交互，用于诊断滚动条闪烁问题
 * 
 * 监控范围：
 * - CustomScrollArea 的 MutationObserver/ResizeObserver 触发
 * - 滚动条 trackActive 状态变化
 * - ProseMirror 选区变化
 * - DOM 尺寸变化
 * - 滚动事件
 */

import React from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { 
  Copy, Trash2, Eye, Filter, Clipboard, 
  AlertTriangle, CheckCircle, XCircle, RefreshCw,
  MousePointer, Maximize2, Move, Scroll
} from 'lucide-react';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============ 类型定义 ============

type LogLevel = 'debug' | 'info' | 'warning' | 'error';

type EventCategory = 
  | 'mutation'        // MutationObserver 触发
  | 'resize'          // ResizeObserver 触发
  | 'scroll'          // 滚动事件
  | 'selection'       // ProseMirror 选区变化
  | 'track'           // 滚动条 track 状态变化
  | 'dimension'       // 尺寸变化
  | 'lifecycle'       // 生命周期
  | 'snapshot';       // 状态快照

interface DimensionSnapshot {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  scrollTop: number;
  scrollLeft: number;
}

interface SelectionSnapshot {
  type: string;
  empty: boolean;
  from: number;
  to: number;
  anchor: number;
  head: number;
}

interface TrackStateSnapshot {
  verticalActive: boolean;
  horizontalActive: boolean;
  verticalThumbSize: number;
  horizontalThumbSize: number;
}

interface DebugLog {
  id: string;
  ts: number;
  category: EventCategory;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  dimensionSnapshot?: DimensionSnapshot;
  selectionSnapshot?: SelectionSnapshot;
  trackSnapshot?: TrackStateSnapshot;
  mutationInfo?: {
    type: string;
    target: string;
    addedNodes: number;
    removedNodes: number;
  };
}

// ============ 常量 ============

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',
};

const LEVEL_ICONS: Record<LogLevel, React.FC<any>> = {
  debug: RefreshCw,
  info: CheckCircle,
  warning: AlertTriangle,
  error: XCircle,
};

const CATEGORY_LABELS: Record<EventCategory, { label: string; icon: React.FC<any>; color: string }> = {
  mutation: { label: 'DOM变化', icon: RefreshCw, color: '#8b5cf6' },
  resize: { label: '尺寸变化', icon: Maximize2, color: '#6366f1' },
  scroll: { label: '滚动事件', icon: Scroll, color: '#10b981' },
  selection: { label: '选区变化', icon: MousePointer, color: '#f97316' },
  track: { label: '滚动条状态', icon: Move, color: '#3b82f6' },
  dimension: { label: '尺寸快照', icon: Maximize2, color: '#06b6d4' },
  lifecycle: { label: '生命周期', icon: RefreshCw, color: '#64748b' },
  snapshot: { label: '状态快照', icon: Eye, color: '#06b6d4' },
};

// ============ 事件通道 ============

export const SCROLL_AREA_DEBUG_EVENT = 'scroll-area-debug';

export interface ScrollAreaDebugEventDetail {
  category: EventCategory;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  dimensionSnapshot?: DimensionSnapshot;
  selectionSnapshot?: SelectionSnapshot;
  trackSnapshot?: TrackStateSnapshot;
  mutationInfo?: DebugLog['mutationInfo'];
}

/**
 * 发射滚动区域调试事件
 */
export const emitScrollAreaDebug = (
  category: EventCategory,
  level: LogLevel,
  message: string,
  details?: Record<string, any>,
  dimensionSnapshot?: DimensionSnapshot,
  selectionSnapshot?: SelectionSnapshot,
  trackSnapshot?: TrackStateSnapshot,
  mutationInfo?: DebugLog['mutationInfo']
) => {
  try {
    const event = new CustomEvent<ScrollAreaDebugEventDetail>(SCROLL_AREA_DEBUG_EVENT, {
      detail: { category, level, message, details, dimensionSnapshot, selectionSnapshot, trackSnapshot, mutationInfo },
    });
    window.dispatchEvent(event);
  } catch (e) {
    console.warn('[ScrollAreaDebug] Event emit failed:', e);
  }
};

/**
 * 捕获滚动容器尺寸快照
 */
export const captureDimensionSnapshot = (viewport?: HTMLElement | null): DimensionSnapshot | null => {
  if (!viewport) {
    viewport = document.querySelector('.scroll-area__viewport') as HTMLElement | null;
  }
  
  if (!viewport) {
    return null;
  }

  return {
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    scrollWidth: viewport.scrollWidth,
    clientWidth: viewport.clientWidth,
    scrollTop: viewport.scrollTop,
    scrollLeft: viewport.scrollLeft,
  };
};

/**
 * 捕获 ProseMirror 选区快照
 */
export const captureSelectionSnapshot = (): SelectionSnapshot | null => {
  try {
    const view = (window as any).__MILKDOWN_VIEW__;
    if (!view || !view.state || !view.state.selection) {
      return null;
    }
    const sel = view.state.selection;
    return {
      type: sel.constructor.name,
      empty: sel.empty,
      from: sel.from,
      to: sel.to,
      anchor: sel.anchor,
      head: sel.head,
    };
  } catch {
    return null;
  }
};

// ============ 插件组件 ============

const ScrollAreaDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const [logs, setLogs] = React.useState<DebugLog[]>([]);
  const [selectedCategory, setSelectedCategory] = React.useState<EventCategory | 'all'>('all');
  const [selectedLevel, setSelectedLevel] = React.useState<LogLevel | 'all'>('all');
  const [keyword, setKeyword] = React.useState('');
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [liveDimension, setLiveDimension] = React.useState<DimensionSnapshot | null>(null);
  const [liveSelection, setLiveSelection] = React.useState<SelectionSnapshot | null>(null);
  const [isPaused, setIsPaused] = React.useState(false);
  const logContainerRef = React.useRef<HTMLDivElement>(null);
  const lastDimensionRef = React.useRef<DimensionSnapshot | null>(null);
  const lastSelectionRef = React.useRef<SelectionSnapshot | null>(null);

  const append = React.useCallback((entry: Omit<DebugLog, 'id'>) => {
    if (isPaused) return;
    setLogs(prev => {
      const next = [...prev, { ...entry, id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }];
      return next.slice(-1000);
    });
  }, [isPaused]);

  // 监听调试事件
  React.useEffect(() => {
    if (!isActivated) return;

    const handleDebugEvent = (event: CustomEvent<ScrollAreaDebugEventDetail>) => {
      append({
        ...event.detail,
        ts: Date.now(),
      });
    };

    window.addEventListener(SCROLL_AREA_DEBUG_EVENT as any, handleDebugEvent);

    // 初始化日志
    append({
      ts: Date.now(),
      category: 'lifecycle',
      level: 'info',
      message: '滚动区域调试插件已激活',
      details: { timestamp: new Date().toISOString() },
    });

    return () => {
      window.removeEventListener(SCROLL_AREA_DEBUG_EVENT as any, handleDebugEvent);
    };
  }, [isActivated, append]);

  // 监听 ProseMirror 选区变化
  React.useEffect(() => {
    if (!isActivated || isPaused) return;

    const checkSelection = () => {
      const sel = captureSelectionSnapshot();
      const last = lastSelectionRef.current;
      
      if (sel && last) {
        // 检测选区变化
        if (sel.from !== last.from || sel.to !== last.to || sel.type !== last.type) {
          const dim = captureDimensionSnapshot();
          append({
            ts: Date.now(),
            category: 'selection',
            level: 'info',
            message: `选区变化: ${last.type}(${last.from}-${last.to}) → ${sel.type}(${sel.from}-${sel.to})`,
            details: {
              wasEmpty: last.empty,
              isNowEmpty: sel.empty,
              fromDelta: sel.from - last.from,
              toDelta: sel.to - last.to,
            },
            selectionSnapshot: sel,
            dimensionSnapshot: dim ?? undefined,
          });
        }
      }
      
      lastSelectionRef.current = sel;
      setLiveSelection(sel);
    };

    // 使用 selectionchange 事件
    document.addEventListener('selectionchange', checkSelection);
    
    // 也监听 mouseup（选区可能在 mouseup 时才稳定）
    document.addEventListener('mouseup', checkSelection);
    
    // 初始检查
    checkSelection();

    return () => {
      document.removeEventListener('selectionchange', checkSelection);
      document.removeEventListener('mouseup', checkSelection);
    };
  }, [isActivated, isPaused, append]);

  // 监听滚动容器尺寸变化
  React.useEffect(() => {
    if (!isActivated || isPaused) return;

    const viewport = document.querySelector('.scroll-area__viewport') as HTMLElement | null;
    if (!viewport) return;

    let frame = 0;

    const checkDimension = () => {
      const dim = captureDimensionSnapshot(viewport);
      const last = lastDimensionRef.current;
      
      if (dim && last) {
        const changed = 
          dim.scrollHeight !== last.scrollHeight ||
          dim.clientHeight !== last.clientHeight ||
          dim.scrollWidth !== last.scrollWidth ||
          dim.clientWidth !== last.clientWidth;
        
        if (changed) {
          append({
            ts: Date.now(),
            category: 'dimension',
            level: 'info',
            message: `尺寸变化: scrollH ${last.scrollHeight}→${dim.scrollHeight}, clientH ${last.clientHeight}→${dim.clientHeight}`,
            details: {
              scrollHeightDelta: dim.scrollHeight - last.scrollHeight,
              clientHeightDelta: dim.clientHeight - last.clientHeight,
              scrollWidthDelta: dim.scrollWidth - last.scrollWidth,
              clientWidthDelta: dim.clientWidth - last.clientWidth,
            },
            dimensionSnapshot: dim,
          });
        }
      }
      
      lastDimensionRef.current = dim;
      setLiveDimension(dim);
    };

    // ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      const sel = captureSelectionSnapshot();
      append({
        ts: Date.now(),
        category: 'resize',
        level: 'debug',
        message: 'ResizeObserver 触发',
        selectionSnapshot: sel ?? undefined,
        dimensionSnapshot: captureDimensionSnapshot(viewport) ?? undefined,
      });
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(checkDimension);
    });
    resizeObserver.observe(viewport);

    // MutationObserver
    const mutationObserver = new MutationObserver((mutations) => {
      const dim = captureDimensionSnapshot(viewport);
      const sel = captureSelectionSnapshot();
      
      // 汇总 mutations
      let addedNodes = 0;
      let removedNodes = 0;
      const types = new Set<string>();
      const targets = new Set<string>();
      
      mutations.forEach(m => {
        types.add(m.type);
        targets.add((m.target as Element).className || m.target.nodeName);
        addedNodes += m.addedNodes.length;
        removedNodes += m.removedNodes.length;
      });

      append({
        ts: Date.now(),
        category: 'mutation',
        level: 'debug',
        message: `MutationObserver 触发: ${mutations.length} 个变化`,
        details: {
          mutationCount: mutations.length,
          types: Array.from(types),
          targetClasses: Array.from(targets).slice(0, 5),
        },
        mutationInfo: {
          type: Array.from(types).join(','),
          target: Array.from(targets).slice(0, 3).join(', '),
          addedNodes,
          removedNodes,
        },
        dimensionSnapshot: dim ?? undefined,
        selectionSnapshot: sel ?? undefined,
      });

      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(checkDimension);
    });
    mutationObserver.observe(viewport, { childList: true, subtree: true, characterData: false });

    // 滚动事件
    const handleScroll = () => {
      append({
        ts: Date.now(),
        category: 'scroll',
        level: 'debug',
        message: '滚动事件触发',
        dimensionSnapshot: captureDimensionSnapshot(viewport) ?? undefined,
      });
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });

    // 初始化
    checkDimension();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      viewport.removeEventListener('scroll', handleScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [isActivated, isPaused, append]);

  // 自动滚动
  React.useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = React.useCallback(() => {
    setLogs([]);
  }, []);

  const filteredLogs = React.useMemo(() => {
    return logs.filter(log => {
      if (errorsOnly && log.level !== 'error' && log.level !== 'warning') return false;
      if (selectedCategory !== 'all' && log.category !== selectedCategory) return false;
      if (selectedLevel !== 'all' && log.level !== selectedLevel) return false;
      if (keyword && !JSON.stringify(log).toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }, [logs, errorsOnly, selectedCategory, selectedLevel, keyword]);

  const copyLog = React.useCallback((log: DebugLog) => {
    const text = JSON.stringify({
      timestamp: new Date(log.ts).toISOString(),
      category: log.category,
      level: log.level,
      message: log.message,
      details: log.details,
      dimensionSnapshot: log.dimensionSnapshot,
      selectionSnapshot: log.selectionSnapshot,
      trackSnapshot: log.trackSnapshot,
      mutationInfo: log.mutationInfo,
    }, null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', '日志已复制到剪贴板');
    }).catch(console.error);
  }, []);
  
  const copyAllLogs = React.useCallback(() => {
    const text = JSON.stringify({
      exportTime: new Date().toISOString(),
      liveDimension,
      liveSelection,
      logs: filteredLogs.map(log => ({
        timestamp: new Date(log.ts).toISOString(),
        category: log.category,
        level: log.level,
        message: log.message,
        details: log.details,
        dimensionSnapshot: log.dimensionSnapshot,
        selectionSnapshot: log.selectionSnapshot,
        trackSnapshot: log.trackSnapshot,
        mutationInfo: log.mutationInfo,
      })),
    }, null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', `已复制 ${filteredLogs.length} 条日志到剪贴板`);
    }).catch(console.error);
  }, [filteredLogs, liveDimension, liveSelection]);

  const triggerSnapshot = React.useCallback(() => {
    const dim = captureDimensionSnapshot();
    const sel = captureSelectionSnapshot();
    setLiveDimension(dim);
    setLiveSelection(sel);
    append({
      ts: Date.now(),
      category: 'snapshot',
      level: 'info',
      message: '手动触发状态快照',
      dimensionSnapshot: dim ?? undefined,
      selectionSnapshot: sel ?? undefined,
    });
  }, [append]);

  const stats = React.useMemo(() => {
    const counts: Record<string, number> = { debug: 0, info: 0, warning: 0, error: 0 };
    const categoryStats: Record<string, number> = {};
    
    logs.forEach(log => {
      counts[log.level]++;
      categoryStats[log.category] = (categoryStats[log.category] || 0) + 1;
    });
    
    return { counts, categoryStats };
  }, [logs]);

  if (!isActivated) return null;

  return (
    <div className="p-4 space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Scroll className="h-5 w-5" />
          滚动区域调试
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={triggerSnapshot}
            className="px-3 py-1 text-sm bg-cyan-500 text-white rounded hover:bg-cyan-600"
            title="手动捕获状态快照"
          >
            <Eye className="h-4 w-4 inline mr-1" />
            快照
          </button>
          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`px-3 py-1 text-sm rounded ${isPaused ? 'bg-yellow-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title={isPaused ? '继续记录' : '暂停记录'}
          >
            {isPaused ? '已暂停' : '记录中'}
          </button>
          <button
            onClick={() => setErrorsOnly(!errorsOnly)}
            className={`px-3 py-1 text-sm rounded ${errorsOnly ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title="仅显示错误和警告"
          >
            <Filter className="h-4 w-4" />
          </button>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-3 py-1 text-sm rounded ${autoScroll ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-700'}`}
            title="自动滚动到底部"
          >
            自动滚动
          </button>
          <button
            onClick={copyAllLogs}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
            disabled={filteredLogs.length === 0}
            title="复制所有日志到剪贴板"
          >
            <Clipboard className="h-4 w-4" />
          </button>
          <button
            onClick={clearLogs}
            className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
            title="清空日志"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 实时状态面板 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 尺寸快照 */}
        <div className="border rounded-lg p-3 bg-slate-50">
          <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
            <Maximize2 className="h-4 w-4" />
            实时尺寸
          </div>
          {liveDimension ? (
            <div className="text-xs font-mono space-y-1">
              <div>scrollHeight: <span className="text-blue-600">{liveDimension.scrollHeight}</span></div>
              <div>clientHeight: <span className="text-blue-600">{liveDimension.clientHeight}</span></div>
              <div>scrollWidth: <span className="text-blue-600">{liveDimension.scrollWidth}</span></div>
              <div>clientWidth: <span className="text-blue-600">{liveDimension.clientWidth}</span></div>
              <div>scrollTop: <span className="text-green-600">{liveDimension.scrollTop}</span></div>
              <div>scrollLeft: <span className="text-green-600">{liveDimension.scrollLeft}</span></div>
              <div className={liveDimension.scrollHeight > liveDimension.clientHeight ? 'text-orange-600' : 'text-gray-500'}>
                可滚动: {liveDimension.scrollHeight > liveDimension.clientHeight ? '是' : '否'}
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500">等待快照...</div>
          )}
        </div>

        {/* 选区快照 */}
        <div className="border rounded-lg p-3 bg-slate-50">
          <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
            <MousePointer className="h-4 w-4" />
            ProseMirror 选区
          </div>
          {liveSelection ? (
            <div className="text-xs font-mono space-y-1">
              <div>类型: <span className="text-purple-600">{liveSelection.type}</span></div>
              <div>空选区: <span className={liveSelection.empty ? 'text-gray-500' : 'text-orange-600'}>{liveSelection.empty ? '是' : '否'}</span></div>
              <div>范围: <span className="text-blue-600">{liveSelection.from} - {liveSelection.to}</span></div>
              <div>anchor: <span className="text-green-600">{liveSelection.anchor}</span></div>
              <div>head: <span className="text-green-600">{liveSelection.head}</span></div>
              <div className={liveSelection.empty ? 'text-gray-500' : 'text-orange-600 font-semibold'}>
                选中字符数: {liveSelection.to - liveSelection.from}
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500">未检测到 ProseMirror 选区</div>
          )}
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

      {/* 分类统计 */}
      <div className="border rounded-lg p-3 bg-gradient-to-r from-purple-50 to-blue-50">
        <div className="text-sm font-medium text-gray-700 mb-2">事件分类统计</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(CATEGORY_LABELS).map(([key, { label, color }]) => {
            const count = stats.categoryStats[key] || 0;
            return (
              <button
                key={key}
                onClick={() => setSelectedCategory(selectedCategory === key ? 'all' : key as EventCategory)}
                className={`px-3 py-1 text-xs rounded-full transition-all ${
                  selectedCategory === key 
                    ? 'ring-2 ring-offset-1' 
                    : 'opacity-75 hover:opacity-100'
                }`}
                style={{ 
                  backgroundColor: `${color}20`, 
                  color: color,
                }}
              >
                {label}: {count}
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
            placeholder="搜索消息、详情..."
            className="w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        
        <div className="min-w-[150px]">
          <label className="block text-xs text-gray-600 mb-1">事件分类</label>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value as any)}
            className="w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">全部分类</option>
            {Object.entries(CATEGORY_LABELS).map(([key, { label }]) => (
              <option key={key} value={key}>{label} ({stats.categoryStats[key] || 0})</option>
            ))}
          </select>
        </div>

        <div className="min-w-[120px]">
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
          {isPaused && <span className="text-yellow-600 text-xs">⏸ 已暂停</span>}
        </div>
        
        <div ref={logContainerRef} className="max-h-[400px] overflow-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <div className="mb-2">{logs.length === 0 ? '暂无日志记录' : '没有符合过滤条件的日志'}</div>
              <div className="text-xs text-gray-400">
                请在笔记编辑器中选中文本，观察选区变化和滚动条状态
              </div>
            </div>
          ) : (
            <div className="divide-y">
              {filteredLogs.map((log) => {
                const Icon = LEVEL_ICONS[log.level];
                const categoryInfo = CATEGORY_LABELS[log.category];
                const CategoryIcon = categoryInfo?.icon || RefreshCw;
                
                return (
                  <div key={log.id} className="p-3 hover:bg-gray-50">
                    <div className="flex items-start gap-3">
                      <Icon 
                        className="h-5 w-5 mt-0.5 flex-shrink-0" 
                        style={{ color: LEVEL_COLORS[log.level] }}
                      />
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs text-gray-500 font-mono">
                            {new Date(log.ts).toLocaleTimeString(undefined, { 
                              hour12: false, 
                              hour: '2-digit', 
                              minute: '2-digit', 
                              second: '2-digit',
                            })}.{String(log.ts % 1000).padStart(3, '0')}
                          </span>
                          <span className="px-2 py-0.5 text-xs rounded flex items-center gap-1" style={{ 
                            backgroundColor: `${categoryInfo?.color || '#64748b'}20`,
                            color: categoryInfo?.color || '#64748b'
                          }}>
                            <CategoryIcon className="h-3 w-3" />
                            {categoryInfo?.label || log.category}
                          </span>
                          <span className="px-2 py-0.5 text-xs rounded" style={{ 
                            backgroundColor: `${LEVEL_COLORS[log.level]}20`,
                            color: LEVEL_COLORS[log.level]
                          }}>
                            {log.level.toUpperCase()}
                          </span>
                        </div>
                        
                        <div className="text-sm text-gray-800 mb-1 font-medium">
                          {log.message}
                        </div>
                        
                        {log.mutationInfo && (
                          <div className="text-xs text-purple-600 mb-1">
                            添加: {log.mutationInfo.addedNodes}, 移除: {log.mutationInfo.removedNodes}, 目标: {log.mutationInfo.target}
                          </div>
                        )}
                        
                        {log.details && Object.keys(log.details).length > 0 && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-gray-600 hover:text-gray-800">
                              查看详细信息 ({Object.keys(log.details).length} 项)
                            </summary>
                            <pre className="mt-2 p-2 bg-gray-100 rounded overflow-auto text-xs max-h-48">
                              {JSON.stringify(log.details, null, 2)}
                            </pre>
                          </details>
                        )}
                        
                        {log.dimensionSnapshot && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-cyan-600 hover:text-cyan-800">
                              尺寸快照
                            </summary>
                            <pre className="mt-2 p-2 bg-cyan-50 rounded overflow-auto text-xs max-h-48">
                              {JSON.stringify(log.dimensionSnapshot, null, 2)}
                            </pre>
                          </details>
                        )}

                        {log.selectionSnapshot && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-orange-600 hover:text-orange-800">
                              选区快照
                            </summary>
                            <pre className="mt-2 p-2 bg-orange-50 rounded overflow-auto text-xs max-h-48">
                              {JSON.stringify(log.selectionSnapshot, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                      
                      <button
                        onClick={() => copyLog(log)}
                        className="p-1 text-gray-400 hover:text-gray-600"
                        title="复制日志"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 使用说明 */}
      <div className="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg">
        <div className="font-medium mb-1">调试提示：</div>
        <ul className="list-disc list-inside space-y-0.5">
          <li>打开笔记编辑器，选中一些文本，观察「选区变化」日志</li>
          <li>关注「DOM变化」和「尺寸变化」日志，确认是否有不必要的触发</li>
          <li>如果选中文本时「尺寸变化」日志频繁触发，说明问题出在这里</li>
          <li>点击「快照」按钮手动捕获当前状态</li>
          <li>点击「暂停」可暂停日志记录，便于分析已有日志</li>
        </ul>
      </div>
    </div>
  );
};

export default ScrollAreaDebugPlugin;
