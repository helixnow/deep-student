/**
 * ChatAnki 解析调试插件
 * 监控 Anki 卡片解析全生命周期：Prompt生成、流式输出、JSON提取、解析、降级、字段映射、补丁发送
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Trash2, Download, ChevronDown, ChevronRight, AlertCircle, CheckCircle, Clock, Filter } from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';

// ============ 类型定义 ============
interface DebugEvent {
  id: string;
  timestamp: number;
  phase: DebugPhase;
  type: string;
  data: any;
  status: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
}

type DebugPhase = 
  | 'prompt'      // Prompt 生成
  | 'template'    // 模板获取
  | 'request'     // AI 请求
  | 'stream'      // 流式输出
  | 'extract'     // JSON 提取
  | 'parse'       // 解析
  | 'downgrade'   // 智能降级
  | 'mapping'     // 字段映射
  | 'patch'       // 补丁发送
  | 'event'       // 事件通知
  | 'ui'          // UI 更新
  | 'error';      // 错误

interface StateSnapshot {
  timestamp: number;
  label: string;
  parserState?: any;
  storeState?: any;
  uiState?: any;
}

// ============ 全局调试收集器 ============
// 节流配置：哪些阶段+类型的日志需要节流
const THROTTLE_CONFIG: Record<string, { interval: number; consoleSuppress: boolean }> = {
  // 流式输出的中间状态：节流 500ms，不输出到控制台
  'stream:chunk_with_delimiter': { interval: 500, consoleSuppress: true },
  'stream:delta_init': { interval: 0, consoleSuppress: true },
  'stream:trailing_delta': { interval: 0, consoleSuppress: true },
  'stream:drain_buffer_start': { interval: 500, consoleSuppress: true },  // 高频调用，节流
  // 缓冲区检查：节流 1000ms，不输出到控制台
  'extract:buffer_check': { interval: 1000, consoleSuppress: true },
  'extract:delimiters_found': { interval: 500, consoleSuppress: true },
  // 解析中间步骤：不输出到控制台
  'parse:raw_input': { interval: 0, consoleSuppress: true },
  'parse:sanitized': { interval: 0, consoleSuppress: true },
  'parse:parsed_json': { interval: 0, consoleSuppress: true },
  // 补丁中间状态：不输出到控制台
  'patch:patches_built': { interval: 0, consoleSuppress: true },
  // 模板缓存：不输出到控制台
  'template:cache_hit': { interval: 0, consoleSuppress: true },
  'template:cache_miss': { interval: 0, consoleSuppress: true },
  // 事件通知：节流 500ms，不输出到控制台（流式过程中高频触发）
  'event:meta_patch_dispatch': { interval: 500, consoleSuppress: true },
};

// 关键日志类型：始终输出到控制台
const ALWAYS_LOG_TYPES = new Set([
  'stream:session_start',
  'stream:session_final',
  'extract:card_extracted',
  'parse:final_card',
  'downgrade:result',
  'mapping:result',
  'patch:card_added',
  'ui:session_success',
  'error:parse_error',
  'error:mode_disabled',
  'error:session_failed',
  'error:parse_exception',
  'template:fetched',
  'template:fetch_failed',
]);

class ChatAnkiDebugCollector {
  private static instance: ChatAnkiDebugCollector;
  private events: DebugEvent[] = [];
  private snapshots: StateSnapshot[] = [];
  private listeners: Set<() => void> = new Set();
  private enabled = false;
  private sessionId: string | null = null;
  private phaseTimers: Map<string, number> = new Map();
  private lastLogTimes: Map<string, number> = new Map();  // 节流用：记录上次日志时间
  private throttledCounts: Map<string, number> = new Map();  // 统计被节流的日志数量

  static getInstance(): ChatAnkiDebugCollector {
    if (!ChatAnkiDebugCollector.instance) {
      ChatAnkiDebugCollector.instance = new ChatAnkiDebugCollector();
    }
    return ChatAnkiDebugCollector.instance;
  }

  enable(sessionId?: string) {
    this.enabled = true;
    this.sessionId = sessionId || null;
    this.clear();
    console.log('[ChatAnkiDebug] 🔧 调试器已启用', { sessionId });
  }

  disable() {
    this.enabled = false;
    console.log('[ChatAnkiDebug] 🔧 调试器已禁用');
  }

  isEnabled() {
    return this.enabled;
  }

  clear() {
    this.events = [];
    this.snapshots = [];
    this.phaseTimers.clear();
    this.lastLogTimes.clear();
    this.throttledCounts.clear();
    this.notifyListeners();
  }

  startPhase(phase: DebugPhase, type: string) {
    const key = `${phase}:${type}`;
    this.phaseTimers.set(key, performance.now());
  }

  log(phase: DebugPhase, type: string, data: any, status: DebugEvent['status'] = 'info') {
    if (!this.enabled) return;

    const key = `${phase}:${type}`;
    const now = Date.now();
    
    // 检查节流配置
    const throttleConfig = THROTTLE_CONFIG[key];
    if (throttleConfig && throttleConfig.interval > 0) {
      const lastTime = this.lastLogTimes.get(key) || 0;
      if (now - lastTime < throttleConfig.interval) {
        // 被节流，更新计数但不记录事件
        this.throttledCounts.set(key, (this.throttledCounts.get(key) || 0) + 1);
        return;
      }
    }
    this.lastLogTimes.set(key, now);

    const startTime = this.phaseTimers.get(key);
    const duration = startTime ? performance.now() - startTime : undefined;
    this.phaseTimers.delete(key);

    // 获取并重置节流计数
    const throttledCount = this.throttledCounts.get(key) || 0;
    if (throttledCount > 0) {
      this.throttledCounts.delete(key);
    }

    const event: DebugEvent = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      phase,
      type,
      data: throttledCount > 0 
        ? { ...this.sanitizeData(data), _throttledCount: throttledCount }
        : this.sanitizeData(data),
      status,
      duration,
    };

    this.events.push(event);
    
    // 控制台输出：仅输出关键日志或错误
    const shouldLogToConsole = 
      status === 'error' ||
      ALWAYS_LOG_TYPES.has(key) ||
      (throttleConfig === undefined && status === 'success');
    
    if (shouldLogToConsole && !(throttleConfig?.consoleSuppress)) {
      const icon = status === 'error' ? '❌' : status === 'warning' ? '⚠️' : status === 'success' ? '✅' : '📝';
      const throttleInfo = throttledCount > 0 ? ` (+${throttledCount} throttled)` : '';
      console.log(`[ChatAnkiDebug] ${icon} [${phase}] ${type}${throttleInfo}`, data);
    }

    this.notifyListeners();
  }

  snapshot(label: string, state: Partial<StateSnapshot>) {
    if (!this.enabled) return;

    const snapshot: StateSnapshot = {
      timestamp: Date.now(),
      label,
      ...state,
    };
    this.snapshots.push(snapshot);
    
    console.log(`[ChatAnkiDebug] 📸 状态快照: ${label}`, state);
    this.notifyListeners();
  }

  getEvents(): DebugEvent[] {
    return [...this.events];
  }

  getSnapshots(): StateSnapshot[] {
    return [...this.snapshots];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    this.listeners.forEach(l => l());
  }

  private sanitizeData(data: any): any {
    try {
      const json = JSON.stringify(data);
      if (json.length > 10000) {
        return { _truncated: true, length: json.length, preview: json.slice(0, 500) + '...' };
      }
      return JSON.parse(json);
    } catch {
      return { _error: 'Failed to serialize', type: typeof data };
    }
  }

  exportReport(): string {
    const report = {
      exportedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      eventCount: this.events.length,
      snapshotCount: this.snapshots.length,
      events: this.events,
      snapshots: this.snapshots,
      summary: this.generateSummary(),
    };
    return JSON.stringify(report, null, 2);
  }

  private generateSummary() {
    const phases = new Map<DebugPhase, { count: number; errors: number; totalDuration: number }>();
    
    for (const event of this.events) {
      const current = phases.get(event.phase) || { count: 0, errors: 0, totalDuration: 0 };
      current.count++;
      if (event.status === 'error') current.errors++;
      if (event.duration) current.totalDuration += event.duration;
      phases.set(event.phase, current);
    }

    return Object.fromEntries(phases);
  }
}

// 导出全局实例
export const chatAnkiParseDebug = ChatAnkiDebugCollector.getInstance();

// 暴露到 window 用于控制台调试
if (typeof window !== 'undefined') {
  (window as any).__chatAnkiParseDebug = chatAnkiParseDebug;
}

// ============ 调试插件组件 ============
const PHASE_LABELS: Record<DebugPhase, string> = {
  prompt: 'Prompt 生成',
  template: '模板获取',
  request: 'AI 请求',
  stream: '流式输出',
  extract: 'JSON 提取',
  parse: '解析',
  downgrade: '智能降级',
  mapping: '字段映射',
  patch: '补丁发送',
  event: '事件通知',
  ui: 'UI 更新',
  error: '错误',
};

const PHASE_COLORS: Record<DebugPhase, string> = {
  prompt: 'bg-blue-500/20 text-blue-400',
  template: 'bg-purple-500/20 text-purple-400',
  request: 'bg-indigo-500/20 text-indigo-400',
  stream: 'bg-cyan-500/20 text-cyan-400',
  extract: 'bg-teal-500/20 text-teal-400',
  parse: 'bg-green-500/20 text-green-400',
  downgrade: 'bg-yellow-500/20 text-yellow-400',
  mapping: 'bg-orange-500/20 text-orange-400',
  patch: 'bg-pink-500/20 text-pink-400',
  event: 'bg-rose-500/20 text-rose-400',
  ui: 'bg-violet-500/20 text-violet-400',
  error: 'bg-red-500/20 text-red-400',
};

const ChatAnkiParseDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const { t } = useTranslation('common');
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [snapshots, setSnapshots] = useState<StateSnapshot[]>([]);
  const [isEnabled, setIsEnabled] = useState(chatAnkiParseDebug.isEnabled());
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<DebugPhase | 'all'>('all');
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // 订阅事件更新
  useEffect(() => {
    if (!isActivated) return;
    
    const unsubscribe = chatAnkiParseDebug.subscribe(() => {
      setEvents(chatAnkiParseDebug.getEvents());
      setSnapshots(chatAnkiParseDebug.getSnapshots());
    });
    
    // 初始化
    setEvents(chatAnkiParseDebug.getEvents());
    setSnapshots(chatAnkiParseDebug.getSnapshots());
    setIsEnabled(chatAnkiParseDebug.isEnabled());
    
    return unsubscribe;
  }, [isActivated]);

  // 自动滚动
  useEffect(() => {
    if (!autoScroll || !containerRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [events, autoScroll]);

  const toggleEnabled = useCallback(() => {
    if (isEnabled) {
      chatAnkiParseDebug.disable();
    } else {
      chatAnkiParseDebug.enable();
    }
    setIsEnabled(!isEnabled);
  }, [isEnabled]);

  const handleClear = useCallback(() => {
    chatAnkiParseDebug.clear();
  }, []);

  const handleCopyReport = useCallback(() => {
    const report = chatAnkiParseDebug.exportReport();
    navigator.clipboard.writeText(report).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const handleDownloadReport = useCallback(() => {
    const report = chatAnkiParseDebug.exportReport();
    const blob = new Blob([report], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-anki-parse-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const toggleEventExpand = useCallback((id: string) => {
    setExpandedEvents(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const filteredEvents = useMemo(() => 
    filter === 'all' ? events : events.filter(e => e.phase === filter),
    [events, filter]
  );

  const statusIcons = {
    info: <Clock className="w-3 h-3 text-gray-400" />,
    success: <CheckCircle className="w-3 h-3 text-green-400" />,
    warning: <AlertCircle className="w-3 h-3 text-yellow-400" />,
    error: <AlertCircle className="w-3 h-3 text-red-400" />,
  };

  const errorCount = useMemo(() => events.filter(e => e.status === 'error').length, [events]);
  const warningCount = useMemo(() => events.filter(e => e.status === 'warning').length, [events]);

  if (!isActivated) {
    return null;
  }

  return (
    <div className="flex flex-col h-full text-gray-200">
      {/* 头部工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleEnabled}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              isEnabled 
                ? 'bg-green-600 text-white hover:bg-green-700' 
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {isEnabled ? '🟢 调试中' : '⚪ 已禁用'}
          </button>
          <div className="text-xs text-gray-400">
            事件: <span className="text-white">{events.length}</span>
            {errorCount > 0 && <span className="text-red-400 ml-2">❌ {errorCount}</span>}
            {warningCount > 0 && <span className="text-yellow-400 ml-2">⚠️ {warningCount}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-xs text-gray-400 mr-2">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded"
            />
            自动滚动
          </label>
          <button
            onClick={handleClear}
            className="p-1.5 rounded hover:bg-gray-700 transition-colors"
            title="清空日志"
          >
            <Trash2 className="w-4 h-4 text-gray-400" />
          </button>
          <button
            onClick={handleCopyReport}
            className="p-1.5 rounded hover:bg-gray-700 transition-colors"
            title="复制报告"
          >
            <Copy className={`w-4 h-4 ${copied ? 'text-green-400' : 'text-gray-400'}`} />
          </button>
          <button
            onClick={handleDownloadReport}
            className="p-1.5 rounded hover:bg-gray-700 transition-colors"
            title="下载报告"
          >
            <Download className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* 过滤器 */}
      <div className="flex items-center gap-1 p-2 border-b border-gray-700 overflow-x-auto">
        <Filter className="w-4 h-4 text-gray-500 mr-1 flex-shrink-0" />
        <button
          onClick={() => setFilter('all')}
          className={`px-2 py-0.5 rounded text-xs whitespace-nowrap transition-colors ${
            filter === 'all' ? 'bg-gray-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          全部
        </button>
        {(Object.keys(PHASE_LABELS) as DebugPhase[]).map(phase => (
          <button
            key={phase}
            onClick={() => setFilter(phase)}
            className={`px-2 py-0.5 rounded text-xs whitespace-nowrap transition-colors ${
              filter === phase ? PHASE_COLORS[phase] : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {PHASE_LABELS[phase]}
          </button>
        ))}
      </div>

      {/* 事件列表 */}
      <div ref={containerRef} className="flex-1 overflow-auto p-2 space-y-1">
        {filteredEvents.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            {isEnabled ? '等待事件...' : '点击"已禁用"按钮启用调试'}
          </div>
        ) : (
          filteredEvents.map(event => (
            <div
              key={event.id}
              className="border border-gray-700 rounded overflow-hidden bg-gray-800/50"
            >
              <div
                onClick={() => toggleEventExpand(event.id)}
                className="flex items-center gap-2 p-2 cursor-pointer hover:bg-gray-700/50 transition-colors"
              >
                {expandedEvents.has(event.id) ? (
                  <ChevronDown className="w-3 h-3 text-gray-500 flex-shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-gray-500 flex-shrink-0" />
                )}
                {statusIcons[event.status]}
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${PHASE_COLORS[event.phase]}`}>
                  {PHASE_LABELS[event.phase]}
                </span>
                <span className="font-medium text-gray-300 truncate flex-1 text-xs">
                  {event.type}
                </span>
                {event.duration !== undefined && (
                  <span className="text-gray-500 text-[10px]">
                    {event.duration.toFixed(1)}ms
                  </span>
                )}
                <span className="text-gray-500 text-[10px]">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {expandedEvents.has(event.id) && (
                <div className="p-2 bg-gray-900 border-t border-gray-700">
                  <pre className="whitespace-pre-wrap break-all text-[10px] text-gray-400 max-h-64 overflow-auto font-mono">
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 快照列表 */}
      {snapshots.length > 0 && (
        <div className="border-t border-gray-700 p-2">
          <div className="text-xs text-gray-400 mb-1">状态快照 ({snapshots.length})</div>
          <div className="flex gap-1 overflow-x-auto">
            {snapshots.map((snap, i) => (
              <button
                key={i}
                className="px-2 py-1 bg-gray-800 rounded text-[10px] text-gray-300 hover:bg-gray-700 whitespace-nowrap"
                onClick={() => console.log('快照详情:', snap)}
              >
                {snap.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatAnkiParseDebugPlugin;
