/**
 * 工具调用全生命周期调试插件
 *
 * 监控 Chat V2 工具调用的完整前后端链路：
 * 1. tool_call_preparing — LLM 流式输出中识别到工具调用意图
 * 2. tool_call start     — 后端开始执行工具
 * 3. tool_call chunk     — 工具流式输出（如 stdout）
 * 4. tool_call end       — 工具执行完成
 * 5. tool_call error     — 工具执行失败
 * 6. replaceBlockId      — 前端 preparing→执行块 ID 转换
 *
 * 自动检测：
 * - 顺序异常（完成顺序 ≠ preparing 顺序）
 * - 超时工具（preparing 超过 30s 未开始执行）
 * - 失败聚合统计
 *
 * 支持一键复制全部日志。
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Copy, Trash2, Download, Search, ChevronDown, ChevronRight, AlertTriangle, CheckCircle, XCircle, Clock, Zap, ArrowRight, Activity } from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';

// ============================================================================
// 常量
// ============================================================================

/** 窗口自定义事件名 — 任何模块均可通过此事件向插件推送日志 */
export const TOOLCALL_LIFECYCLE_EVENT = 'toolcall-debug-lifecycle';

const MAX_LOGS = 3000;
const PREPARE_TIMEOUT_MS = 30_000;

// ============================================================================
// 类型
// ============================================================================

export type ToolCallLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';

export type ToolCallLogPhase =
  | 'backend:preparing'     // LLM 正在生成工具调用参数
  | 'backend:start'         // 后端开始执行工具
  | 'backend:chunk'         // 工具流式输出
  | 'backend:end'           // 工具执行完成
  | 'backend:error'         // 工具执行失败
  | 'frontend:preparing'    // 前端创建 preparing 块
  | 'frontend:replaceId'    // 前端 preparing→执行块 ID 替换
  | 'frontend:blockUpdate'  // 前端块状态更新（running/success/error）
  | 'bridge:dispatch'       // eventBridge 分发事件
  | 'bridge:sequence'       // 序列号/乱序缓冲事件
  | 'anomaly:ordering'      // 完成顺序异常检测
  | 'anomaly:timeout'       // preparing 超时检测
  | 'system';               // 系统事件（清空等）

export interface ToolCallLogEntry {
  id: string;
  ts: number;
  level: ToolCallLogLevel;
  phase: ToolCallLogPhase;
  summary: string;
  detail?: unknown;
  toolName?: string;
  toolCallId?: string;
  blockId?: string;
  sequenceId?: number;
  durationMs?: number;
}

// ============================================================================
// 全局日志收集器
// ============================================================================

let logIdCounter = 0;
const globalLogs: ToolCallLogEntry[] = [];
const globalListeners = new Set<(entry: ToolCallLogEntry) => void>();

export function pushToolCallLog(
  level: ToolCallLogLevel,
  phase: ToolCallLogPhase,
  summary: string,
  opts?: Partial<Pick<ToolCallLogEntry, 'detail' | 'toolName' | 'toolCallId' | 'blockId' | 'sequenceId' | 'durationMs'>>,
): void {
  const entry: ToolCallLogEntry = {
    id: `tcl-${++logIdCounter}`,
    ts: Date.now(),
    level,
    phase,
    summary,
    ...opts,
  };
  globalLogs.push(entry);
  if (globalLogs.length > MAX_LOGS) globalLogs.splice(0, globalLogs.length - MAX_LOGS);
  globalListeners.forEach((fn) => fn(entry));
}

function snapshotLogs(): ToolCallLogEntry[] {
  return globalLogs.slice();
}

function clearLogs(): void {
  globalLogs.length = 0;
  logIdCounter = 0;
}

// ============================================================================
// 窗口事件桥接 — 任何模块可通过 window.dispatchEvent 推送日志
// ============================================================================

/**
 * 向调试插件发送工具调用生命周期日志
 *
 * 使用方式（任何模块）：
 * ```ts
 * window.dispatchEvent(new CustomEvent('toolcall-debug-lifecycle', {
 *   detail: {
 *     level: 'info',
 *     phase: 'backend:start',
 *     summary: 'Tool execution started: pptx_create',
 *     toolName: 'pptx_create',
 *     toolCallId: 'tc_123',
 *     blockId: 'blk_456',
 *     detail: { toolInput: {...} },
 *   }
 * }));
 * ```
 */
function handleWindowEvent(e: Event): void {
  const ce = e as CustomEvent;
  if (!ce.detail) return;
  const d = ce.detail as Record<string, unknown>;
  pushToolCallLog(
    (d.level as ToolCallLogLevel) || 'info',
    (d.phase as ToolCallLogPhase) || 'system',
    (d.summary as string) || '',
    {
      detail: d.detail,
      toolName: d.toolName as string | undefined,
      toolCallId: d.toolCallId as string | undefined,
      blockId: d.blockId as string | undefined,
      sequenceId: d.sequenceId as number | undefined,
      durationMs: d.durationMs as number | undefined,
    },
  );
}

// 模块加载时即注册全局监听器（确保不遗漏早期事件）
if (typeof window !== 'undefined') {
  window.addEventListener(TOOLCALL_LIFECYCLE_EVENT, handleWindowEvent);
}

/**
 * 便捷发射函数（避免每次手写 CustomEvent）
 */
export function emitToolCallDebug(
  level: ToolCallLogLevel,
  phase: ToolCallLogPhase,
  summary: string,
  opts?: Partial<Pick<ToolCallLogEntry, 'detail' | 'toolName' | 'toolCallId' | 'blockId' | 'sequenceId' | 'durationMs'>>,
): void {
  pushToolCallLog(level, phase, summary, opts);
}

// ============================================================================
// 工具内部追踪器 — 检测顺序异常和超时
// ============================================================================

interface InflightTool {
  toolCallId: string;
  toolName: string;
  blockId?: string;
  preparingAt: number;
  startedAt?: number;
  endedAt?: number;
  preparingOrder: number;  // LLM 流式输出顺序（跨轮次可能不连续）
  startOrder?: number;     // 后端实际开始执行顺序（同轮次内连续）
  warnedTimeout?: boolean;
}

const inflightTools = new Map<string, InflightTool>();
let preparingCounter = 0;
let startCounter = 0;
let completionCounter = 0;
/** 当前轮次 ID（用于检测跨轮次） */
let currentRoundId = 0;

function resetTracker(): void {
  inflightTools.clear();
  preparingCounter = 0;
  startCounter = 0;
  completionCounter = 0;
}

/**
 * 重置轮次计数器（每次 stream_start 时调用）
 * 避免跨轮次 preparing/completion 计数器比较产生假阳性
 */
export function resetRound(): void {
  // 清理上一轮残留的 inflight 工具（超时未完成的）
  const staleCount = inflightTools.size;
  if (staleCount > 0) {
    pushToolCallLog('warn', 'system', `新轮次开始，清理 ${staleCount} 个上轮残留工具`, {
      detail: { staleTools: Array.from(inflightTools.values()).map(t => ({ toolName: t.toolName, toolCallId: t.toolCallId })) },
    });
    inflightTools.clear();
  }
  preparingCounter = 0;
  startCounter = 0;
  completionCounter = 0;
  currentRoundId++;
  pushToolCallLog('info', 'system', `=== 轮次 #${currentRoundId} 开始 ===`);
}

export function trackPreparing(toolCallId: string, toolName: string): void {
  inflightTools.set(toolCallId, {
    toolCallId,
    toolName,
    preparingAt: Date.now(),
    preparingOrder: ++preparingCounter,
  });
}

export function trackStart(toolCallId: string, blockId?: string, toolName?: string): void {
  let t = inflightTools.get(toolCallId);
  // 🔧 回填：如果没有 preparing 事件（如 image_gen、approval、直接调用），
  // 创建一个补录的 InflightTool 条目，确保 trackEnd 能正常输出计时日志
  if (!t && toolName) {
    t = {
      toolCallId,
      toolName,
      preparingAt: Date.now(),
      preparingOrder: 0, // 0 表示无 preparing 阶段
    };
    inflightTools.set(toolCallId, t);
  }
  if (t) {
    t.startedAt = Date.now();
    t.startOrder = ++startCounter;
    if (blockId) t.blockId = blockId;
    if (toolName && !t.toolName) t.toolName = toolName;
  }
}

export function trackEnd(toolCallId: string, success: boolean): void {
  const t = inflightTools.get(toolCallId);
  if (!t) return;
  t.endedAt = Date.now();
  const currentCompletion = ++completionCounter;

  const execMs = t.startedAt ? t.endedAt - t.startedAt : undefined;
  const totalMs = t.endedAt - t.preparingAt;
  const waitMs = t.startedAt ? t.startedAt - t.preparingAt : undefined;

  pushToolCallLog(
    success ? 'success' : 'error',
    success ? 'backend:end' : 'backend:error',
    `${t.toolName} ${success ? '完成' : '失败'} | start#${t.startOrder ?? '?'} → end#${currentCompletion} | wait=${waitMs ?? '?'}ms exec=${execMs ?? '?'}ms total=${totalMs}ms`,
    {
      toolName: t.toolName,
      toolCallId,
      blockId: t.blockId,
      durationMs: execMs,
      detail: {
        preparingOrder: t.preparingOrder,
        startOrder: t.startOrder,
        completionOrder: currentCompletion,
        preparingAt: t.preparingAt,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        waitMs,
        execMs,
        totalMs,
      },
    },
  );

  // 顺序异常检测：只在 start-order ≠ completion-order 时报告
  // （说明后端执行顺序和完成顺序不一致，即有工具被跳过或并发执行）
  // preparing-order ≠ start-order 是正常的（LLM 流式顺序 ≠ 解析后顺序）
  if (t.startOrder != null && t.startOrder !== currentCompletion) {
    pushToolCallLog('warn', 'anomaly:ordering', `执行乱序: ${t.toolName} start#${t.startOrder} 但 end#${currentCompletion}`, {
      toolName: t.toolName,
      toolCallId,
      detail: { startOrder: t.startOrder, completionOrder: currentCompletion },
    });
  }

  inflightTools.delete(toolCallId);

  // 🆕 轮次汇总：当所有 inflight 工具都已完成时，输出本轮统计
  if (inflightTools.size === 0 && completionCounter > 1) {
    const roundLogs = globalLogs.filter(
      (l) => l.phase === 'backend:end' || l.phase === 'backend:error'
    );
    // 取最近 completionCounter 条作为本轮
    const roundEntries = roundLogs.slice(-completionCounter);
    const successes = roundEntries.filter((l) => l.level === 'success').length;
    const failures = roundEntries.filter((l) => l.level === 'error').length;
    const durations = roundEntries.map((l) => l.durationMs).filter((d): d is number => d != null);
    const avgMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const maxMs = durations.length > 0 ? Math.max(...durations) : 0;
    pushToolCallLog('info', 'system',
      `=== 轮次 #${currentRoundId} 汇总: ${completionCounter} 个工具 | ✓${successes} ✗${failures} | 平均=${avgMs}ms 最大=${maxMs}ms ===`,
      { detail: { round: currentRoundId, total: completionCounter, successes, failures, avgMs, maxMs } },
    );
  }
}

// 定期检测超时（preparing 后迟迟未收到 start）
if (typeof window !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [, t] of inflightTools) {
      if (!t.startedAt && !t.warnedTimeout && now - t.preparingAt > PREPARE_TIMEOUT_MS) {
        t.warnedTimeout = true;
        pushToolCallLog('warn', 'anomaly:timeout', `${t.toolName} preparing 已超过 ${PREPARE_TIMEOUT_MS / 1000}s 仍未开始执行`, {
          toolName: t.toolName,
          toolCallId: t.toolCallId,
          durationMs: now - t.preparingAt,
        });
      }
    }
  }, 5000);
}

// ============================================================================
// UI 常量
// ============================================================================

const LEVEL_COLORS: Record<ToolCallLogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  success: '#10b981',
  warn: '#f59e0b',
  error: '#ef4444',
};

const LEVEL_ICONS: Record<ToolCallLogLevel, React.FC<any>> = {
  debug: Activity,
  info: Zap,
  success: CheckCircle,
  warn: AlertTriangle,
  error: XCircle,
};

const PHASE_LABELS: Record<ToolCallLogPhase, string> = {
  'backend:preparing': '准备中',
  'backend:start': '开始执行',
  'backend:chunk': '流式输出',
  'backend:end': '执行完成',
  'backend:error': '执行失败',
  'frontend:preparing': '创建块',
  'frontend:replaceId': 'ID替换',
  'frontend:blockUpdate': '块更新',
  'bridge:dispatch': '事件分发',
  'bridge:sequence': '序列号',
  'anomaly:ordering': '⚠️ 顺序异常',
  'anomaly:timeout': '⚠️ 超时',
  'system': '系统',
};

// ============================================================================
// 格式化辅助
// ============================================================================

function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function buildCopyText(logs: ToolCallLogEntry[]): string {
  const lines = logs.map((l) => {
    const parts = [
      formatTs(l.ts),
      `[${l.level.toUpperCase()}]`,
      `[${l.phase}]`,
    ];
    if (l.toolName) parts.push(`tool=${l.toolName}`);
    if (l.toolCallId) parts.push(`tcId=${l.toolCallId}`);
    if (l.blockId) parts.push(`blk=${l.blockId}`);
    if (l.sequenceId != null) parts.push(`seq=${l.sequenceId}`);
    if (l.durationMs != null) parts.push(`${l.durationMs}ms`);
    parts.push(l.summary);
    if (l.detail) parts.push(`\n  detail: ${stringify(l.detail)}`);
    return parts.join(' ');
  });
  return lines.join('\n');
}

// ============================================================================
// React 组件
// ============================================================================

const ToolCallLifecycleDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<ToolCallLogEntry[]>(snapshotLogs);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<ToolCallLogLevel | 'all'>('all');
  const [phaseFilter, setPhaseFilter] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // 订阅全局日志
  useEffect(() => {
    if (!isActivated) return;
    setLogs(snapshotLogs());
    const handler = (_entry: ToolCallLogEntry) => {
      setLogs(snapshotLogs());
    };
    globalListeners.add(handler);
    return () => { globalListeners.delete(handler); };
  }, [isActivated]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // 过滤
  const filteredLogs = useMemo(() => {
    let result = logs;
    if (levelFilter !== 'all') {
      result = result.filter((l) => l.level === levelFilter);
    }
    if (phaseFilter !== 'all') {
      result = result.filter((l) => l.phase.startsWith(phaseFilter));
    }
    if (filter.trim()) {
      const q = filter.toLowerCase();
      result = result.filter((l) =>
        l.summary.toLowerCase().includes(q) ||
        l.toolName?.toLowerCase().includes(q) ||
        l.toolCallId?.toLowerCase().includes(q) ||
        l.blockId?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [logs, levelFilter, phaseFilter, filter]);

  // 统计
  const stats = useMemo(() => {
    const total = logs.length;
    const errors = logs.filter((l) => l.level === 'error').length;
    const warnings = logs.filter((l) => l.level === 'warn').length;
    const anomalies = logs.filter((l) => l.phase.startsWith('anomaly:')).length;
    return { total, errors, warnings, anomalies };
  }, [logs]);

  const handleClear = useCallback(() => {
    clearLogs();
    resetTracker();
    setLogs([]);
    setExpandedIds(new Set());
    pushToolCallLog('info', 'system', '日志已清空');
    setLogs(snapshotLogs());
  }, []);

  const handleCopy = useCallback(async () => {
    const text = buildCopyText(filteredLogs);
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    }
  }, [filteredLogs]);

  const handleDownload = useCallback(() => {
    const text = buildCopyText(filteredLogs);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tool-call-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!visible || !isActive) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
      {/* 统计栏 */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>工具调用生命周期</span>
        <span style={{ color: '#6b7280' }}>共 {stats.total}</span>
        {stats.errors > 0 && <span style={{ color: '#ef4444', fontWeight: 600 }}>✗ {stats.errors}</span>}
        {stats.warnings > 0 && <span style={{ color: '#f59e0b', fontWeight: 600 }}>⚠ {stats.warnings}</span>}
        {stats.anomalies > 0 && <span style={{ color: '#f97316', fontWeight: 600 }}>🔀 {stats.anomalies} 异常</span>}
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: '#6b7280' }}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          自动滚动
        </label>
        <button onClick={handleCopy} title="复制日志" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: copyFeedback ? '#10b981' : '#6b7280' }}>
          <Copy size={14} />
        </button>
        <button onClick={handleDownload} title="下载日志" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#6b7280' }}>
          <Download size={14} />
        </button>
        <button onClick={handleClear} title="清空" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#6b7280' }}>
          <Trash2 size={14} />
        </button>
      </div>

      {/* 过滤栏 */}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Search size={12} style={{ color: '#6b7280' }} />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索工具名/ID/内容..."
          style={{ flex: 1, minWidth: 120, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', fontSize: 11, outline: 'none' }}
        />
        <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as any)} style={{ fontSize: 11, background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px' }}>
          <option value="all">全部级别</option>
          <option value="error">❌ Error</option>
          <option value="warn">⚠️ Warn</option>
          <option value="success">✅ Success</option>
          <option value="info">ℹ️ Info</option>
          <option value="debug">🔍 Debug</option>
        </select>
        <select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)} style={{ fontSize: 11, background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px' }}>
          <option value="all">全部阶段</option>
          <option value="backend:">后端事件</option>
          <option value="frontend:">前端状态</option>
          <option value="bridge:">事件桥接</option>
          <option value="anomaly:">⚠ 异常检测</option>
        </select>
        <span style={{ color: '#6b7280', fontSize: 11 }}>({filteredLogs.length})</span>
      </div>

      {/* 日志列表 */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 0 }}>
        {filteredLogs.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#6b7280', padding: 24 }}>
            {isActivated ? '等待工具调用事件...' : '请先激活此插件'}
          </div>
        ) : (
          filteredLogs.map((entry) => {
            const LevelIcon = LEVEL_ICONS[entry.level] || Activity;
            const isExpanded = expandedIds.has(entry.id);
            const hasDetail = entry.detail != null;
            return (
              <div
                key={entry.id}
                style={{
                  borderBottom: '1px solid var(--border)',
                  padding: '3px 8px',
                  background: entry.phase.startsWith('anomaly:') ? 'rgba(249, 115, 22, 0.06)' : undefined,
                }}
              >
                {/* 主行 */}
                <div
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 4, cursor: hasDetail ? 'pointer' : 'default' }}
                  onClick={() => hasDetail && toggleExpand(entry.id)}
                >
                  {hasDetail ? (
                    isExpanded ? <ChevronDown size={12} style={{ marginTop: 1, flexShrink: 0, color: '#6b7280' }} /> : <ChevronRight size={12} style={{ marginTop: 1, flexShrink: 0, color: '#6b7280' }} />
                  ) : (
                    <span style={{ width: 12, flexShrink: 0 }} />
                  )}
                  <LevelIcon size={12} style={{ marginTop: 1, flexShrink: 0, color: LEVEL_COLORS[entry.level] }} />
                  <span style={{ color: '#6b7280', flexShrink: 0, fontSize: 10 }}>{formatTs(entry.ts)}</span>
                  <span style={{
                    flexShrink: 0,
                    fontSize: 10,
                    padding: '0 4px',
                    borderRadius: 3,
                    background: entry.phase.startsWith('anomaly:') ? '#fef3c7' : 'var(--muted)',
                    color: entry.phase.startsWith('anomaly:') ? '#92400e' : '#6b7280',
                  }}>
                    {PHASE_LABELS[entry.phase] || entry.phase}
                  </span>
                  {entry.toolName && (
                    <span style={{ flexShrink: 0, fontWeight: 600, color: LEVEL_COLORS[entry.level] }}>{entry.toolName}</span>
                  )}
                  {entry.durationMs != null && (
                    <span style={{ flexShrink: 0, color: entry.durationMs > 5000 ? '#ef4444' : '#6b7280', fontSize: 10 }}>
                      {entry.durationMs}ms
                    </span>
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground)' }}>
                    {entry.summary}
                  </span>
                </div>
                {/* ID 行 */}
                {(entry.toolCallId || entry.blockId || entry.sequenceId != null) && (
                  <div style={{ marginLeft: 16, display: 'flex', gap: 8, fontSize: 10, color: '#9ca3af' }}>
                    {entry.toolCallId && <span>tcId={entry.toolCallId.slice(0, 12)}</span>}
                    {entry.blockId && <span>blk={entry.blockId.slice(0, 12)}</span>}
                    {entry.sequenceId != null && <span>seq={entry.sequenceId}</span>}
                  </div>
                )}
                {/* 展开详情 */}
                {isExpanded && entry.detail && (
                  <pre style={{
                    marginLeft: 16,
                    marginTop: 2,
                    padding: '4px 6px',
                    borderRadius: 4,
                    background: 'var(--muted)',
                    fontSize: 10,
                    lineHeight: 1.4,
                    maxHeight: 200,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    {stringify(entry.detail)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default ToolCallLifecycleDebugPlugin;
