/**
 * Crepe 编辑器调试插件
 * 全面监控 Crepe 编辑器的完整生命周期，用于诊断无法编辑等问题
 * 
 * 监控范围：
 * - 初始化流程（container, Crepe实例, create()）
 * - 依赖加载（Prism, Milkdown插件）
 * - DOM 状态（data-ready, contentEditable, pointer-events）
 * - 编辑器事件（focus, blur, markdownUpdated）
 * - 错误捕获
 */

import React from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { 
  Copy, Save, AlertTriangle, CheckCircle, XCircle, Filter, 
  Clipboard, Trash2, RefreshCw, Eye, Play, Settings, Code 
} from 'lucide-react';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { debugMasterSwitch } from '../debugMasterSwitch';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============ 类型定义 ============

type LogLevel = 'debug' | 'info' | 'warning' | 'error';

type EventCategory = 
  | 'lifecycle'       // 生命周期：mount/unmount/create/destroy
  | 'init'            // 初始化：container/Crepe实例/配置
  | 'dependency'      // 依赖：Prism/插件加载
  | 'dom'             // DOM状态：data-ready/contentEditable
  | 'editor'          // 编辑器事件：focus/blur/change
  | 'error'           // 错误捕获
  | 'snapshot';       // 状态快照

interface DOMSnapshot {
  wrapperExists: boolean;
  dataReady: string | null;
  milkdownExists: boolean;
  proseMirrorExists: boolean;
  contentEditable: string | null;
  pointerEvents: string | null;
  opacity: string | null;
  wrapperClassName: string;
  childCount: number;
}

interface EditorSnapshot {
  crepeExists: boolean;
  isReady: boolean;
  readonly: boolean;
  noteId: string | null;
  subject?: string | null;
  markdownLength: number;
}

interface DebugLog {
  id: string;
  ts: number;
  category: EventCategory;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  domSnapshot?: DOMSnapshot;
  editorSnapshot?: EditorSnapshot;
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
  lifecycle: { label: '生命周期', icon: RefreshCw, color: '#8b5cf6' },
  init: { label: '初始化', icon: Settings, color: '#6366f1' },
  dependency: { label: '依赖加载', icon: Code, color: '#10b981' },
  dom: { label: 'DOM状态', icon: Eye, color: '#f97316' },
  editor: { label: '编辑器事件', icon: Play, color: '#3b82f6' },
  error: { label: '错误', icon: XCircle, color: '#ef4444' },
  snapshot: { label: '状态快照', icon: Eye, color: '#06b6d4' },
};

// ============ 事件通道 ============

export const CREPE_DEBUG_EVENT = 'crepe-editor-debug';

export interface CrepeDebugEventDetail {
  category: EventCategory;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  domSnapshot?: DOMSnapshot;
  editorSnapshot?: EditorSnapshot;
}

/**
 * 发射 Crepe 调试事件
 */
export const emitCrepeDebug = (
  category: EventCategory,
  level: LogLevel,
  message: string,
  details?: Record<string, any>,
  domSnapshot?: DOMSnapshot,
  editorSnapshot?: EditorSnapshot
) => {
  try {
    // 默认不派发任何调试事件，避免编辑器输入期间产生额外开销（尤其是 IME 合成态）
    if (!debugMasterSwitch.isEnabled()) return;
    const event = new CustomEvent<CrepeDebugEventDetail>(CREPE_DEBUG_EVENT, {
      detail: { category, level, message, details, domSnapshot, editorSnapshot },
    });
    window.dispatchEvent(event);
  } catch (e) {
    console.warn('[CrepeDebug] Event emit failed:', e);
  }
};

/**
 * 捕获 DOM 快照
 */
export const captureDOMSnapshot = (container?: HTMLElement | null): DOMSnapshot => {
  if (!container) {
    // 尝试从 DOM 中查找
    container = document.querySelector('.crepe-editor-wrapper') as HTMLElement | null;
  }
  
  if (!container) {
    return {
      wrapperExists: false,
      dataReady: null,
      milkdownExists: false,
      proseMirrorExists: false,
      contentEditable: null,
      pointerEvents: null,
      opacity: null,
      wrapperClassName: '',
      childCount: 0,
    };
  }

  const milkdown = container.querySelector('.milkdown');
  const proseMirror = container.querySelector('.ProseMirror');
  const computedStyle = window.getComputedStyle(container);

  return {
    wrapperExists: true,
    dataReady: container.getAttribute('data-ready'),
    milkdownExists: !!milkdown,
    proseMirrorExists: !!proseMirror,
    contentEditable: proseMirror?.getAttribute('contenteditable') ?? null,
    pointerEvents: computedStyle.pointerEvents,
    opacity: computedStyle.opacity,
    wrapperClassName: container.className,
    childCount: container.childElementCount,
  };
};

// ============ 插件组件 ============

const CrepeEditorDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const [logs, setLogs] = React.useState<DebugLog[]>([]);
  const [selectedCategory, setSelectedCategory] = React.useState<EventCategory | 'all'>('all');
  const [selectedLevel, setSelectedLevel] = React.useState<LogLevel | 'all'>('all');
  const [keyword, setKeyword] = React.useState('');
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [liveSnapshot, setLiveSnapshot] = React.useState<DOMSnapshot | null>(null);
  const logContainerRef = React.useRef<HTMLDivElement>(null);

  const append = React.useCallback((entry: Omit<DebugLog, 'id'>) => {
    setLogs(prev => {
      const next = [...prev, { ...entry, id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }];
      return next.slice(-500);
    });
  }, []);

  // 监听调试事件
  React.useEffect(() => {
    if (!isActivated) return;

    const handleDebugEvent = (event: CustomEvent<CrepeDebugEventDetail>) => {
      append({
        ...event.detail,
        ts: Date.now(),
      });
    };

    window.addEventListener(CREPE_DEBUG_EVENT as any, handleDebugEvent);

    // 监听全局错误
    const handleError = (event: ErrorEvent) => {
      if (event.message?.includes('Prism') || 
          event.message?.includes('milkdown') || 
          event.message?.includes('crepe') ||
          event.message?.includes('ProseMirror')) {
        append({
          ts: Date.now(),
          category: 'error',
          level: 'error',
          message: `全局错误捕获: ${event.message}`,
          details: {
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            error: event.error?.toString(),
          },
        });
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = String(event.reason);
      if (reason.includes('Prism') || 
          reason.includes('milkdown') || 
          reason.includes('crepe') ||
          reason.includes('ProseMirror')) {
        append({
          ts: Date.now(),
          category: 'error',
          level: 'error',
          message: `Promise 拒绝: ${reason}`,
          details: {
            reason: event.reason?.toString(),
            stack: event.reason?.stack,
          },
        });
      }
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    // 初始化日志
    append({
      ts: Date.now(),
      category: 'lifecycle',
      level: 'info',
      message: 'Crepe 编辑器调试插件已激活',
      details: { timestamp: new Date().toISOString() },
    });

    return () => {
      window.removeEventListener(CREPE_DEBUG_EVENT as any, handleDebugEvent);
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [isActivated, append]);

  // 定时刷新 DOM 快照
  React.useEffect(() => {
    if (!isActivated) return;

    const interval = setInterval(() => {
      setLiveSnapshot(captureDOMSnapshot());
    }, 1000);

    return () => clearInterval(interval);
  }, [isActivated]);

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
      domSnapshot: log.domSnapshot,
      editorSnapshot: log.editorSnapshot,
    }, null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', '日志已复制到剪贴板');
    }).catch(console.error);
  }, []);
  
  const copyAllLogs = React.useCallback(() => {
    const text = JSON.stringify(filteredLogs.map(log => ({
      timestamp: new Date(log.ts).toISOString(),
      category: log.category,
      level: log.level,
      message: log.message,
      details: log.details,
      domSnapshot: log.domSnapshot,
      editorSnapshot: log.editorSnapshot,
    })), null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', `已复制 ${filteredLogs.length} 条日志到剪贴板`);
    }).catch(console.error);
  }, [filteredLogs]);

  const exportLogs = React.useCallback(() => {
    const data = JSON.stringify({
      exportTime: new Date().toISOString(),
      liveSnapshot,
      logs: logs.map(l => ({
        ...l,
        timestamp: new Date(l.ts).toISOString(),
      })),
    }, null, 2);
    
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crepe-editor-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs, liveSnapshot]);

  // 手动触发快照
  const triggerSnapshot = React.useCallback(() => {
    const domSnapshot = captureDOMSnapshot();
    setLiveSnapshot(domSnapshot);
    append({
      ts: Date.now(),
      category: 'snapshot',
      level: 'info',
      message: '手动触发 DOM 快照',
      domSnapshot,
    });
  }, [append]);

  // 诊断分析
  const diagnosis = React.useMemo(() => {
    if (!liveSnapshot) return null;

    const issues: string[] = [];
    const hints: string[] = [];

    if (!liveSnapshot.wrapperExists) {
      issues.push('❌ Crepe 编辑器容器不存在');
      hints.push('检查 NotesCrepeEditor 是否正确渲染');
    } else {
      if (liveSnapshot.dataReady === 'false') {
        issues.push('❌ data-ready="false"，编辑器未就绪');
        hints.push('检查 Crepe.create() 是否成功完成');
      }
      
      if (!liveSnapshot.milkdownExists) {
        issues.push('❌ .milkdown 容器不存在');
        hints.push('Crepe 实例可能未正确创建');
      }
      
      if (!liveSnapshot.proseMirrorExists) {
        issues.push('❌ ProseMirror 编辑器不存在');
        hints.push('Milkdown 编辑器可能初始化失败');
      } else if (liveSnapshot.contentEditable !== 'true') {
        issues.push(`⚠️ contentEditable="${liveSnapshot.contentEditable}"，应为 "true"`);
        hints.push('编辑器可能处于只读模式或未正确初始化');
      }

      if (liveSnapshot.pointerEvents === 'none') {
        issues.push('❌ pointer-events: none，点击事件被阻止');
        hints.push('检查 CSS 规则，可能是 data-ready="false" 导致');
      }
    }

    // 检查错误日志
    const errorLogs = logs.filter(l => l.level === 'error');
    if (errorLogs.length > 0) {
      issues.push(`⚠️ 存在 ${errorLogs.length} 条错误日志`);
      const prismErrors = errorLogs.filter(l => l.message.includes('Prism'));
      if (prismErrors.length > 0) {
        hints.push('Prism 加载错误可能导致代码高亮失败');
      }
    }

    return { issues, hints, isHealthy: issues.length === 0 };
  }, [liveSnapshot, logs]);

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
          <Code className="h-5 w-5" />
          Crepe 编辑器调试
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={triggerSnapshot}
            className="px-3 py-1 text-sm bg-cyan-500 text-white rounded hover:bg-cyan-600"
            title="手动捕获 DOM 快照"
          >
            <Eye className="h-4 w-4 inline mr-1" />
            快照
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
            onClick={exportLogs}
            className="px-3 py-1 text-sm bg-indigo-500 text-white rounded hover:bg-indigo-600"
            disabled={logs.length === 0}
            title="导出日志为JSON文件"
          >
            <Save className="h-4 w-4" />
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

      {/* 实时 DOM 快照 & 诊断 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* DOM 快照 */}
        <div className="border rounded-lg p-3 bg-slate-50">
          <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
            <Eye className="h-4 w-4" />
            实时 DOM 快照
          </div>
          {liveSnapshot ? (
            <div className="text-xs font-mono space-y-1">
              <div className={liveSnapshot.wrapperExists ? 'text-green-600' : 'text-red-600'}>
                wrapper: {liveSnapshot.wrapperExists ? '✓' : '✗'}
              </div>
              <div className={liveSnapshot.dataReady === 'true' ? 'text-green-600' : 'text-red-600'}>
                data-ready: {liveSnapshot.dataReady ?? 'null'}
              </div>
              <div className={liveSnapshot.milkdownExists ? 'text-green-600' : 'text-red-600'}>
                .milkdown: {liveSnapshot.milkdownExists ? '✓' : '✗'}
              </div>
              <div className={liveSnapshot.proseMirrorExists ? 'text-green-600' : 'text-red-600'}>
                .ProseMirror: {liveSnapshot.proseMirrorExists ? '✓' : '✗'}
              </div>
              <div className={liveSnapshot.contentEditable === 'true' ? 'text-green-600' : 'text-orange-600'}>
                contentEditable: {liveSnapshot.contentEditable ?? 'null'}
              </div>
              <div className={liveSnapshot.pointerEvents !== 'none' ? 'text-green-600' : 'text-red-600'}>
                pointer-events: {liveSnapshot.pointerEvents}
              </div>
              <div className="text-gray-500">
                opacity: {liveSnapshot.opacity}
              </div>
              <div className="text-gray-500">
                children: {liveSnapshot.childCount}
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500">等待快照...</div>
          )}
        </div>

        {/* 诊断结果 */}
        <div className={`border rounded-lg p-3 ${diagnosis?.isHealthy ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <div className="text-sm font-medium mb-2 flex items-center gap-2">
            {diagnosis?.isHealthy ? (
              <>
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="text-green-700">状态正常</span>
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <span className="text-red-700">检测到问题</span>
              </>
            )}
          </div>
          {diagnosis && !diagnosis.isHealthy && (
            <div className="space-y-2">
              <div className="text-xs space-y-1">
                {diagnosis.issues.map((issue, i) => (
                  <div key={i} className="text-red-700">{issue}</div>
                ))}
              </div>
              {diagnosis.hints.length > 0 && (
                <div className="text-xs text-gray-600 border-t pt-2 mt-2">
                  <div className="font-medium mb-1">建议：</div>
                  {diagnosis.hints.map((hint, i) => (
                    <div key={i}>• {hint}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {diagnosis?.isHealthy && (
            <div className="text-xs text-green-600">编辑器各项指标正常</div>
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
        </div>
        
        <div ref={logContainerRef} className="max-h-[400px] overflow-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <div className="mb-2">{logs.length === 0 ? '暂无日志记录' : '没有符合过滤条件的日志'}</div>
              <div className="text-xs text-gray-400">
                请打开笔记模块并选择一条笔记，观察编辑器初始化日志
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
                        
                        {log.domSnapshot && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-orange-600 hover:text-orange-800">
                              DOM 快照
                            </summary>
                            <pre className="mt-2 p-2 bg-orange-50 rounded overflow-auto text-xs max-h-48">
                              {JSON.stringify(log.domSnapshot, null, 2)}
                            </pre>
                          </details>
                        )}

                        {log.editorSnapshot && (
                          <details className="text-xs mt-2">
                            <summary className="cursor-pointer text-blue-600 hover:text-blue-800">
                              编辑器快照
                            </summary>
                            <pre className="mt-2 p-2 bg-blue-50 rounded overflow-auto text-xs max-h-48">
                              {JSON.stringify(log.editorSnapshot, null, 2)}
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
          <li>打开笔记模块，选择一条笔记，观察编辑器初始化日志</li>
          <li>检查「实时 DOM 快照」中的各项状态是否为绿色</li>
          <li>关注 <code className="bg-gray-200 px-1 rounded">data-ready</code> 和 <code className="bg-gray-200 px-1 rounded">contentEditable</code> 属性</li>
          <li>错误日志会显示 Prism/Milkdown 相关的加载失败信息</li>
          <li>点击「快照」按钮手动捕获当前 DOM 状态</li>
        </ul>
      </div>
    </div>
  );
};

export default CrepeEditorDebugPlugin;
