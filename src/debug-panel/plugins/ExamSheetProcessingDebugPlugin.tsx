/**
 * 题目集识别全生命周期调试插件
 *
 * 监控两阶段题目集识别的完整前后端链路：
 * 1. frontend:invoke-start   — 前端发起 processExamSheetPreview 调用
 * 2. backend:session-created  — 后端创建会话
 * 3. backend:ocr-page         — 阶段一：单页 OCR 完成
 * 4. backend:ocr-phase-done   — 阶段一全部完成
 * 5. backend:parse-page       — 阶段二：单页解析完成
 * 6. backend:completed        — 两阶段全部完成
 * 7. backend:failed           — 处理失败
 * 8. frontend:hook-state      — useExamSheetProgress hook 状态变化
 * 9. frontend:invoke-end      — 前端 invoke 返回
 * 10. frontend:navigate       — 前端导航到 summary 页面
 *
 * 自动检测：
 * - Completed 事件是否被前端接收
 * - invoke 返回后 hook 状态是否正确重置
 * - 两阶段耗时统计
 *
 * 支持一键复制全部日志。
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Copy, Trash, Download, MagnifyingGlass, CaretDown, CaretRight, Warning, CheckCircle, XCircle, Clock, Lightning, Pulse, Eye } from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { Switch } from '@/components/ui/shad/Switch';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 常量
// ============================================================================

export const EXAM_SHEET_LIFECYCLE_EVENT = 'exam-sheet-lifecycle-debug';

const MAX_LOGS = 2000;

// ============================================================================
// 类型
// ============================================================================

export type ExamSheetLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';

export type ExamSheetLogPhase =
  | 'frontend:invoke-start'    // 前端发起 invoke
  | 'frontend:invoke-end'      // invoke 返回（成功/失败）
  | 'frontend:hook-state'      // hook 状态变化
  | 'frontend:navigate'        // 导航到 summary
  | 'frontend:reset'           // 状态重置
  | 'backend:session-created'  // 会话创建
  | 'backend:ocr-page'         // 单页 OCR 完成
  | 'backend:ocr-phase-done'   // OCR 阶段全部完成
  | 'backend:parse-page'       // 单页解析完成
  | 'backend:chunk'            // 兼容旧版 ChunkCompleted
  | 'backend:completed'        // 全部完成
  | 'backend:failed'           // 处理失败
  | 'anomaly:event-missed'     // Completed 事件未被接收
  | 'anomaly:stuck'            // 卡在处理中
  | 'system';                  // 系统事件

export interface ExamSheetLogEntry {
  id: string;
  ts: number;
  level: ExamSheetLogLevel;
  phase: ExamSheetLogPhase;
  summary: string;
  detail?: unknown;
  sessionId?: string;
  pageIndex?: number;
  totalPages?: number;
  durationMs?: number;
}

// ============================================================================
// 全局日志收集器
// ============================================================================

let logIdCounter = 0;
const globalLogs: ExamSheetLogEntry[] = [];
const globalListeners = new Set<(entry: ExamSheetLogEntry) => void>();

export function pushExamSheetLog(
  level: ExamSheetLogLevel,
  phase: ExamSheetLogPhase,
  summary: string,
  opts?: Partial<Pick<ExamSheetLogEntry, 'detail' | 'sessionId' | 'pageIndex' | 'totalPages' | 'durationMs'>>,
): void {
  const entry: ExamSheetLogEntry = {
    id: `esl-${++logIdCounter}`,
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

function snapshotLogs(): ExamSheetLogEntry[] {
  return globalLogs.slice();
}

function clearLogs(): void {
  globalLogs.length = 0;
  logIdCounter = 0;
}

// ============================================================================
// 窗口事件桥接
// ============================================================================

function handleWindowEvent(e: Event): void {
  const ce = e as CustomEvent;
  if (!ce.detail) return;
  const d = ce.detail as Record<string, unknown>;
  pushExamSheetLog(
    (d.level as ExamSheetLogLevel) || 'info',
    (d.phase as ExamSheetLogPhase) || 'system',
    (d.summary as string) || '',
    {
      detail: d.detail,
      sessionId: d.sessionId as string | undefined,
      pageIndex: d.pageIndex as number | undefined,
      totalPages: d.totalPages as number | undefined,
      durationMs: d.durationMs as number | undefined,
    },
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener(EXAM_SHEET_LIFECYCLE_EVENT, handleWindowEvent);
}

/**
 * 便捷发射函数
 */
export function emitExamSheetDebug(
  level: ExamSheetLogLevel,
  phase: ExamSheetLogPhase,
  summary: string,
  opts?: Partial<Pick<ExamSheetLogEntry, 'detail' | 'sessionId' | 'pageIndex' | 'totalPages' | 'durationMs'>>,
): void {
  pushExamSheetLog(level, phase, summary, opts);
}

// ============================================================================
// 会话追踪器 — 检测卡住和事件丢失
// ============================================================================

interface InflightSession {
  sessionId: string;
  invokeStartAt: number;
  sessionCreatedAt?: number;
  ocrPhaseStartAt?: number;
  ocrPhaseDoneAt?: number;
  parsePhaseStartAt?: number;
  completedAt?: number;
  failedAt?: number;
  invokeEndAt?: number;
  totalPages: number;
  ocrPagesCompleted: number;
  parsePagesCompleted: number;
  completedEventReceived: boolean;
  warnedStuck?: boolean;
}

const inflightSessions = new Map<string, InflightSession>();
let currentSessionKey = '';

function getOrCreateSession(sessionId: string): InflightSession {
  let s = inflightSessions.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      invokeStartAt: Date.now(),
      totalPages: 0,
      ocrPagesCompleted: 0,
      parsePagesCompleted: 0,
      completedEventReceived: false,
    };
    inflightSessions.set(sessionId, s);
    currentSessionKey = sessionId;
  }
  return s;
}

function emitSessionSummary(s: InflightSession): void {
  const ocrMs = s.ocrPhaseDoneAt && s.ocrPhaseStartAt ? s.ocrPhaseDoneAt - s.ocrPhaseStartAt : undefined;
  const parseMs = s.completedAt && s.ocrPhaseDoneAt ? s.completedAt - s.ocrPhaseDoneAt : undefined;
  const totalMs = (s.completedAt || s.failedAt || Date.now()) - s.invokeStartAt;

  pushExamSheetLog('info', 'system',
    `=== 会话汇总: ${s.sessionId.slice(0, 16)} | OCR=${s.ocrPagesCompleted}/${s.totalPages} Parse=${s.parsePagesCompleted}/${s.totalPages} | OCR耗时=${ocrMs ?? '?'}ms 解析耗时=${parseMs ?? '?'}ms 总耗时=${totalMs}ms | Completed事件=${s.completedEventReceived ? '✓' : '✗'} ===`,
    {
      sessionId: s.sessionId,
      durationMs: totalMs,
      detail: {
        ocrMs,
        parseMs,
        totalMs,
        ocrPages: `${s.ocrPagesCompleted}/${s.totalPages}`,
        parsePages: `${s.parsePagesCompleted}/${s.totalPages}`,
        completedEventReceived: s.completedEventReceived,
        invokeEndReceived: !!s.invokeEndAt,
        timestamps: {
          invokeStart: s.invokeStartAt,
          sessionCreated: s.sessionCreatedAt,
          ocrPhaseDone: s.ocrPhaseDoneAt,
          completed: s.completedAt,
          invokeEnd: s.invokeEndAt,
        },
      },
    },
  );
}

// 定期检测卡住
if (typeof window !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [, s] of inflightSessions) {
      if (!s.completedAt && !s.failedAt && !s.warnedStuck && now - s.invokeStartAt > 120_000) {
        s.warnedStuck = true;
        pushExamSheetLog('warn', 'anomaly:stuck',
          `会话 ${s.sessionId.slice(0, 16)} 已超过 2 分钟仍未完成 | OCR=${s.ocrPagesCompleted}/${s.totalPages} Parse=${s.parsePagesCompleted}/${s.totalPages}`,
          { sessionId: s.sessionId, durationMs: now - s.invokeStartAt },
        );
      }
    }
  }, 10_000);
}

// ============================================================================
// Tauri 事件监听（模块加载时即注册）
// ============================================================================

let tauriListenerAttached = false;

async function attachTauriListener(): Promise<void> {
  if (tauriListenerAttached) return;
  tauriListenerAttached = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<any>('exam_sheet_progress', ({ payload }) => {
      if (!payload) return;
      const type = payload.type as string;
      const detail = payload.detail;
      const sessionId = detail?.summary?.id || payload.session_id || currentSessionKey || '?';

      switch (type) {
        case 'SessionCreated': {
          const totalPages = payload.total_pages ?? payload.total_chunks ?? 0;
          const s = getOrCreateSession(sessionId);
          s.sessionCreatedAt = Date.now();
          s.totalPages = totalPages;
          s.ocrPhaseStartAt = Date.now();
          pushExamSheetLog('info', 'backend:session-created',
            `会话创建: ${sessionId.slice(0, 16)} | ${totalPages} 页`,
            { sessionId, totalPages, detail: { examName: detail?.summary?.exam_name } },
          );
          break;
        }
        case 'OcrPageCompleted': {
          const s = getOrCreateSession(sessionId);
          s.ocrPagesCompleted = (payload.page_index ?? 0) + 1;
          pushExamSheetLog('info', 'backend:ocr-page',
            `OCR 页面 ${s.ocrPagesCompleted}/${s.totalPages} 完成`,
            { sessionId, pageIndex: payload.page_index, totalPages: s.totalPages },
          );
          break;
        }
        case 'OcrPhaseCompleted': {
          const s = getOrCreateSession(sessionId);
          s.ocrPhaseDoneAt = Date.now();
          const ocrMs = s.ocrPhaseStartAt ? s.ocrPhaseDoneAt - s.ocrPhaseStartAt : undefined;
          pushExamSheetLog('success', 'backend:ocr-phase-done',
            `OCR 阶段完成: ${s.totalPages} 页 | 耗时 ${ocrMs ?? '?'}ms`,
            { sessionId, totalPages: s.totalPages, durationMs: ocrMs },
          );
          break;
        }
        case 'ParsePageCompleted': {
          const s = getOrCreateSession(sessionId);
          s.parsePagesCompleted = (payload.page_index ?? 0) + 1;
          if (!s.ocrPhaseDoneAt) {
            // 解析阶段开始但 OCR 阶段未标记完成 — 异常
            pushExamSheetLog('warn', 'anomaly:event-missed',
              `ParsePageCompleted 收到但 OcrPhaseCompleted 未收到`,
              { sessionId },
            );
          }
          pushExamSheetLog('info', 'backend:parse-page',
            `解析页面 ${s.parsePagesCompleted}/${s.totalPages} 完成`,
            { sessionId, pageIndex: payload.page_index, totalPages: s.totalPages },
          );
          break;
        }
        case 'ChunkCompleted': {
          const s = getOrCreateSession(sessionId);
          s.ocrPagesCompleted++;
          pushExamSheetLog('info', 'backend:chunk',
            `[兼容] Chunk ${payload.chunk_index + 1}/${payload.total_chunks} 完成`,
            { sessionId },
          );
          break;
        }
        case 'Completed': {
          const s = getOrCreateSession(sessionId);
          s.completedAt = Date.now();
          s.completedEventReceived = true;
          const totalMs = s.invokeStartAt ? s.completedAt - s.invokeStartAt : undefined;
          const cardCount = detail?.preview?.pages?.reduce((sum: number, p: any) => sum + (p.cards?.length ?? 0), 0) ?? '?';
          pushExamSheetLog('success', 'backend:completed',
            `★ 处理完成: ${s.totalPages} 页, ${cardCount} 个题目 | 总耗时 ${totalMs ?? '?'}ms`,
            { sessionId, durationMs: totalMs, detail: { cardCount, pages: s.totalPages } },
          );
          emitSessionSummary(s);
          break;
        }
        case 'Failed': {
          const s = getOrCreateSession(sessionId);
          s.failedAt = Date.now();
          pushExamSheetLog('error', 'backend:failed',
            `处理失败: ${payload.error}`,
            { sessionId, detail: { error: payload.error } },
          );
          emitSessionSummary(s);
          break;
        }
        default:
          pushExamSheetLog('debug', 'system', `未知事件类型: ${type}`, { sessionId, detail: payload });
      }
    });
    pushExamSheetLog('info', 'system', 'Tauri exam_sheet_progress 监听器已注册');
  } catch (err) {
    pushExamSheetLog('error', 'system', `Tauri 监听器注册失败: ${err}`);
  }
}

// 模块加载时即注册
if (typeof window !== 'undefined') {
  attachTauriListener();
}

// ============================================================================
// UI 常量
// ============================================================================

const LEVEL_COLORS: Record<ExamSheetLogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  success: '#10b981',
  warn: '#f59e0b',
  error: '#ef4444',
};

const LEVEL_ICONS: Record<ExamSheetLogLevel, React.FC<any>> = {
  debug: Pulse,
  info: Lightning,
  success: CheckCircle,
  warn: Warning,
  error: XCircle,
};

const PHASE_LABELS: Record<ExamSheetLogPhase, string> = {
  'frontend:invoke-start': '发起调用',
  'frontend:invoke-end': '调用返回',
  'frontend:hook-state': 'Hook状态',
  'frontend:navigate': '页面导航',
  'frontend:reset': '状态重置',
  'backend:session-created': '会话创建',
  'backend:ocr-page': 'OCR页面',
  'backend:ocr-phase-done': 'OCR完成',
  'backend:parse-page': '解析页面',
  'backend:chunk': '旧版Chunk',
  'backend:completed': '★ 完成',
  'backend:failed': '✗ 失败',
  'anomaly:event-missed': '⚠ 事件丢失',
  'anomaly:stuck': '⚠ 卡住',
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

function buildCopyText(logs: ExamSheetLogEntry[]): string {
  const lines = logs.map((l) => {
    const parts = [
      formatTs(l.ts),
      `[${l.level.toUpperCase()}]`,
      `[${l.phase}]`,
    ];
    if (l.sessionId) parts.push(`sid=${l.sessionId.slice(0, 16)}`);
    if (l.pageIndex != null) parts.push(`page=${l.pageIndex}`);
    if (l.totalPages != null) parts.push(`total=${l.totalPages}`);
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

const ExamSheetProcessingDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<ExamSheetLogEntry[]>(snapshotLogs);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<ExamSheetLogLevel | 'all'>('all');
  const [phaseFilter, setPhaseFilter] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // 订阅全局日志
  useEffect(() => {
    if (!isActivated) return;
    setLogs(snapshotLogs());
    const handler = (_entry: ExamSheetLogEntry) => {
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
        l.sessionId?.toLowerCase().includes(q)
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
    const completed = logs.filter((l) => l.phase === 'backend:completed').length;
    return { total, errors, warnings, anomalies, completed };
  }, [logs]);

  const handleClear = useCallback(() => {
    clearLogs();
    inflightSessions.clear();
    setLogs([]);
    setExpandedIds(new Set());
    pushExamSheetLog('info', 'system', '日志已清空');
    setLogs(snapshotLogs());
  }, []);

  const handleCopy = useCallback(async () => {
    const text = buildCopyText(filteredLogs);
    try {
      await copyTextToClipboard(text);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
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
    a.download = `exam-sheet-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
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
        <span style={{ fontWeight: 600 }}>题目集识别生命周期</span>
        <span style={{ color: '#6b7280' }}>共 {stats.total}</span>
        {stats.completed > 0 && <span style={{ color: '#10b981', fontWeight: 600 }}>✓ {stats.completed} 完成</span>}
        {stats.errors > 0 && <span style={{ color: '#ef4444', fontWeight: 600 }}>✗ {stats.errors}</span>}
        {stats.warnings > 0 && <span style={{ color: '#f59e0b', fontWeight: 600 }}>⚠ {stats.warnings}</span>}
        {stats.anomalies > 0 && <span style={{ color: '#f97316', fontWeight: 600 }}>🔀 {stats.anomalies} 异常</span>}
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: '#6b7280' }}>
          <Switch size="sm" checked={autoScroll} onCheckedChange={setAutoScroll} />
          自动滚动
        </label>
        <button onClick={handleCopy} title="复制日志" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: copyFeedback ? '#10b981' : '#6b7280' }}>
          <Copy size={14} />
        </button>
        <button onClick={handleDownload} title="下载日志" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#6b7280' }}>
          <Download size={14} />
        </button>
        <button onClick={handleClear} title="清空" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#6b7280' }}>
          <Trash size={14} />
        </button>
      </div>

      {/* 过滤栏 */}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <MagnifyingGlass size={12} style={{ color: '#6b7280' }} />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索会话ID/内容..."
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
          <option value="anomaly:">⚠ 异常检测</option>
          <option value="system">📊 系统/汇总</option>
        </select>
        <span style={{ color: '#6b7280', fontSize: 11 }}>({filteredLogs.length})</span>
      </div>

      {/* 日志列表 */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 0 }}>
        {filteredLogs.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#6b7280', padding: 24 }}>
            {isActivated ? '等待题目集识别事件... 上传试卷图片即可开始监控' : '请先激活此插件'}
          </div>
        ) : (
          filteredLogs.map((entry) => {
            const LevelIcon = LEVEL_ICONS[entry.level] || Pulse;
            const isExpanded = expandedIds.has(entry.id);
            const hasDetail = entry.detail != null;
            return (
              <div
                key={entry.id}
                style={{
                  borderBottom: '1px solid var(--border)',
                  padding: '3px 8px',
                  background: entry.phase.startsWith('anomaly:')
                    ? 'rgba(249, 115, 22, 0.06)'
                    : entry.phase === 'backend:completed'
                      ? 'rgba(16, 185, 129, 0.06)'
                      : entry.phase === 'backend:failed'
                        ? 'rgba(239, 68, 68, 0.06)'
                        : undefined,
                }}
              >
                {/* 主行 */}
                <div
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 4, cursor: hasDetail ? 'pointer' : 'default' }}
                  onClick={() => hasDetail && toggleExpand(entry.id)}
                >
                  {hasDetail ? (
                    isExpanded ? <CaretDown size={12} style={{ marginTop: 1, flexShrink: 0, color: '#6b7280' }} /> : <CaretRight size={12} style={{ marginTop: 1, flexShrink: 0, color: '#6b7280' }} />
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
                    background: entry.phase === 'backend:completed'
                      ? '#d1fae5'
                      : entry.phase === 'backend:failed'
                        ? '#fee2e2'
                        : entry.phase.startsWith('anomaly:')
                          ? '#fef3c7'
                          : 'var(--muted)',
                    color: entry.phase === 'backend:completed'
                      ? '#065f46'
                      : entry.phase === 'backend:failed'
                        ? '#991b1b'
                        : entry.phase.startsWith('anomaly:')
                          ? '#92400e'
                          : '#6b7280',
                  }}>
                    {PHASE_LABELS[entry.phase] || entry.phase}
                  </span>
                  {entry.durationMs != null && (
                    <span style={{ flexShrink: 0, color: entry.durationMs > 30000 ? '#ef4444' : entry.durationMs > 10000 ? '#f59e0b' : '#6b7280', fontSize: 10 }}>
                      {entry.durationMs > 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs}ms`}
                    </span>
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground)' }}>
                    {entry.summary}
                  </span>
                </div>
                {/* 会话 ID 行 */}
                {entry.sessionId && (
                  <div style={{ marginLeft: 16, display: 'flex', gap: 8, fontSize: 10, color: '#9ca3af' }}>
                    <span>sid={entry.sessionId.slice(0, 20)}</span>
                    {entry.pageIndex != null && <span>page={entry.pageIndex}</span>}
                    {entry.totalPages != null && <span>total={entry.totalPages}</span>}
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

export default ExamSheetProcessingDebugPlugin;
