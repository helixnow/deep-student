/**
 * 题目导入流程调试插件
 *
 * 监控流式导入 (question_import_progress) 的完整前后端链路：
 * 1. backend:preprocessing     — 文档预处理（解码/提取/存储图片/创建会话）
 * 2. backend:rendering-pages   — 页面渲染（Visual-First PDF 路径）
 * 3. backend:ocr-image         — VLM/OCR 单张图片完成
 * 4. backend:ocr-phase-done    — VLM/OCR 阶段全部完成
 * 5. backend:extracting-figs   — 配图裁切提取
 * 6. backend:structuring       — LLM 结构化进度
 * 7. backend:session-created   — 导入会话已创建
 * 8. backend:chunk-start       — 分块 LLM 解析开始
 * 9. backend:chunk-completed   — 分块 LLM 解析完成
 * 10. backend:question-parsed  — 单道题目解析完成
 * 11. backend:completed        — 导入完成
 * 12. backend:failed           — 导入失败
 * 13. frontend:invoke-start    — 前端发起 importQuestionBankStream 调用
 * 14. frontend:invoke-end      — 前端 invoke 返回
 * 15. anomaly:stuck            — 导入卡住（超 3 分钟无完成/失败）
 * 16. anomaly:progress-regress — 进度条回退
 *
 * 自动检测：
 * - 导入是否超时卡住
 * - 进度百分比是否回退
 * - 各阶段耗时统计
 *
 * 支持一键复制/下载全部日志。
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Copy, Trash, Download, MagnifyingGlass, CaretDown, CaretRight, Warning, CheckCircle, XCircle, Clock, Lightning, Pulse, FileText } from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { Switch } from '@/components/ui/shad/Switch';

// ============================================================================
// 常量
// ============================================================================

const MAX_LOGS = 3000;

// ============================================================================
// 类型
// ============================================================================

export type ImportLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';

export type ImportLogPhase =
  | 'frontend:invoke-start'
  | 'frontend:invoke-end'
  | 'backend:preprocessing'
  | 'backend:rendering-pages'
  | 'backend:ocr-image'
  | 'backend:ocr-phase-done'
  | 'backend:extracting-figs'
  | 'backend:structuring'
  | 'backend:session-created'
  | 'backend:chunk-start'
  | 'backend:chunk-completed'
  | 'backend:question-parsed'
  | 'backend:completed'
  | 'backend:failed'
  | 'anomaly:stuck'
  | 'anomaly:progress-regress'
  | 'system';

export interface ImportLogEntry {
  id: string;
  ts: number;
  level: ImportLogLevel;
  phase: ImportLogPhase;
  summary: string;
  detail?: unknown;
  sessionId?: string;
  percent?: number;
  durationMs?: number;
}

// ============================================================================
// 全局日志收集器
// ============================================================================

let logIdCounter = 0;
const globalLogs: ImportLogEntry[] = [];
const globalListeners = new Set<(entry: ImportLogEntry) => void>();

export function pushImportLog(
  level: ImportLogLevel,
  phase: ImportLogPhase,
  summary: string,
  opts?: Partial<Pick<ImportLogEntry, 'detail' | 'sessionId' | 'percent' | 'durationMs'>>,
): void {
  const entry: ImportLogEntry = {
    id: `qil-${++logIdCounter}`,
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

function snapshotLogs(): ImportLogEntry[] {
  return globalLogs.slice();
}

function clearLogs(): void {
  globalLogs.length = 0;
  logIdCounter = 0;
}

/**
 * 便捷发射函数（供 ExamSheetUploader 等外部组件调用）
 */
export function emitImportDebug(
  level: ImportLogLevel,
  phase: ImportLogPhase,
  summary: string,
  opts?: Partial<Pick<ImportLogEntry, 'detail' | 'sessionId' | 'percent' | 'durationMs'>>,
): void {
  pushImportLog(level, phase, summary, opts);
}

// ============================================================================
// 会话追踪器
// ============================================================================

interface InflightImport {
  sessionId: string;
  startAt: number;
  sessionCreatedAt?: number;
  preprocessDoneAt?: number;
  ocrPhaseStartAt?: number;
  ocrPhaseDoneAt?: number;
  structuringStartAt?: number;
  completedAt?: number;
  failedAt?: number;
  totalImages: number;
  ocrImagesCompleted: number;
  totalChunks: number;
  chunksCompleted: number;
  totalParsed: number;
  lastPercent: number;
  warnedStuck?: boolean;
}

const inflightImports = new Map<string, InflightImport>();
let currentImportKey = '';

function getOrCreateImport(sessionId: string): InflightImport {
  let s = inflightImports.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      startAt: Date.now(),
      totalImages: 0,
      ocrImagesCompleted: 0,
      totalChunks: 0,
      chunksCompleted: 0,
      totalParsed: 0,
      lastPercent: 0,
    };
    inflightImports.set(sessionId, s);
    currentImportKey = sessionId;
  }
  return s;
}

function emitImportSummary(s: InflightImport): void {
  const preprocessMs = s.preprocessDoneAt && s.startAt ? s.preprocessDoneAt - s.startAt : undefined;
  const ocrMs = s.ocrPhaseDoneAt && s.ocrPhaseStartAt ? s.ocrPhaseDoneAt - s.ocrPhaseStartAt : undefined;
  const structMs = s.completedAt && s.structuringStartAt ? s.completedAt - s.structuringStartAt : undefined;
  const totalMs = (s.completedAt || s.failedAt || Date.now()) - s.startAt;

  pushImportLog('info', 'system',
    `=== 导入汇总: ${s.sessionId.slice(0, 16)} | 图片=${s.ocrImagesCompleted}/${s.totalImages} 块=${s.chunksCompleted}/${s.totalChunks} 题目=${s.totalParsed} | 预处理=${preprocessMs ?? '?'}ms OCR=${ocrMs ?? '?'}ms 结构化=${structMs ?? '?'}ms 总耗时=${totalMs}ms ===`,
    {
      sessionId: s.sessionId,
      durationMs: totalMs,
      detail: {
        preprocessMs,
        ocrMs,
        structMs,
        totalMs,
        images: `${s.ocrImagesCompleted}/${s.totalImages}`,
        chunks: `${s.chunksCompleted}/${s.totalChunks}`,
        totalParsed: s.totalParsed,
        timestamps: {
          start: s.startAt,
          preprocessDone: s.preprocessDoneAt,
          ocrPhaseDone: s.ocrPhaseDoneAt,
          structuringStart: s.structuringStartAt,
          completed: s.completedAt,
          failed: s.failedAt,
        },
      },
    },
  );
}

// 定期检测卡住（3 分钟）
if (typeof window !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [, s] of inflightImports) {
      if (!s.completedAt && !s.failedAt && !s.warnedStuck && now - s.startAt > 180_000) {
        s.warnedStuck = true;
        pushImportLog('warn', 'anomaly:stuck',
          `导入 ${s.sessionId.slice(0, 16)} 已超过 3 分钟仍未完成 | 图片=${s.ocrImagesCompleted}/${s.totalImages} 块=${s.chunksCompleted}/${s.totalChunks} 题目=${s.totalParsed}`,
          { sessionId: s.sessionId, durationMs: now - s.startAt },
        );
      }
    }
  }, 15_000);
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
    await listen<Record<string, any>>('question_import_progress', ({ payload }) => {
      if (!payload) return;
      const type = payload.type as string;
      const sessionId = payload.session_id || currentImportKey || '?';

      switch (type) {
        case 'Preprocessing': {
          const s = getOrCreateImport(sessionId);
          const stage = payload.stage || '';
          const message = payload.message || '';
          const pct = payload.percent ?? 0;
          s.lastPercent = Math.max(s.lastPercent, pct);
          if (stage === 'creating_session') {
            s.preprocessDoneAt = Date.now();
          }
          pushImportLog('info', 'backend:preprocessing',
            `[${stage}] ${message} (${pct}%)`,
            { sessionId, percent: pct, detail: { stage, message } },
          );
          break;
        }
        case 'RenderingPages': {
          const s = getOrCreateImport(sessionId);
          const current = payload.current ?? 0;
          const total = payload.total ?? 0;
          pushImportLog('info', 'backend:rendering-pages',
            `渲染页面 ${current}/${total}`,
            { sessionId, detail: { current, total } },
          );
          break;
        }
        case 'OcrImageCompleted': {
          const s = getOrCreateImport(sessionId);
          const idx = (payload.image_index ?? 0) + 1;
          const total = payload.total_images ?? 0;
          s.ocrImagesCompleted = idx;
          s.totalImages = total;
          if (!s.ocrPhaseStartAt) s.ocrPhaseStartAt = Date.now();
          pushImportLog('info', 'backend:ocr-image',
            `VLM/OCR 图片 ${idx}/${total} 完成`,
            { sessionId, detail: { image_index: payload.image_index, total_images: total } },
          );
          break;
        }
        case 'OcrPhaseCompleted': {
          const s = getOrCreateImport(sessionId);
          s.ocrPhaseDoneAt = Date.now();
          const ocrMs = s.ocrPhaseStartAt ? s.ocrPhaseDoneAt - s.ocrPhaseStartAt : undefined;
          pushImportLog('success', 'backend:ocr-phase-done',
            `VLM/OCR 阶段完成: ${payload.total_images} 张图片, ${payload.total_chars} 字符 | 耗时 ${ocrMs ?? '?'}ms`,
            { sessionId, durationMs: ocrMs, detail: { total_images: payload.total_images, total_chars: payload.total_chars } },
          );
          break;
        }
        case 'ExtractingFigures': {
          const s = getOrCreateImport(sessionId);
          pushImportLog('info', 'backend:extracting-figs',
            `配图提取 ${payload.current}/${payload.total}`,
            { sessionId, detail: { current: payload.current, total: payload.total } },
          );
          break;
        }
        case 'StructuringQuestion': {
          const s = getOrCreateImport(sessionId);
          if (!s.structuringStartAt) s.structuringStartAt = Date.now();
          pushImportLog('info', 'backend:structuring',
            `LLM 结构化 ${payload.current}/${payload.total}`,
            { sessionId, detail: { current: payload.current, total: payload.total } },
          );
          break;
        }
        case 'SessionCreated': {
          const s = getOrCreateImport(payload.session_id || sessionId);
          s.sessionCreatedAt = Date.now();
          s.totalChunks = payload.total_chunks ?? 0;
          if (payload.session_id) currentImportKey = payload.session_id;
          pushImportLog('info', 'backend:session-created',
            `会话创建: ${(payload.session_id || sessionId).slice(0, 16)} | ${payload.name || '?'} | ${payload.total_chunks ?? 0} 块`,
            { sessionId: payload.session_id || sessionId, detail: { name: payload.name, total_chunks: payload.total_chunks } },
          );
          break;
        }
        case 'ChunkStart': {
          const s = getOrCreateImport(sessionId);
          if (!s.structuringStartAt) s.structuringStartAt = Date.now();
          pushImportLog('info', 'backend:chunk-start',
            `块 ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks} 开始解析`,
            { sessionId, detail: { chunk_index: payload.chunk_index, total_chunks: payload.total_chunks } },
          );
          break;
        }
        case 'ChunkCompleted': {
          const s = getOrCreateImport(sessionId);
          s.chunksCompleted = (payload.chunk_index ?? 0) + 1;
          s.totalChunks = payload.total_chunks ?? s.totalChunks;
          s.totalParsed = payload.total_parsed ?? s.totalParsed;
          pushImportLog('info', 'backend:chunk-completed',
            `块 ${s.chunksCompleted}/${s.totalChunks} 完成 | 本块 ${payload.questions_in_chunk ?? 0} 题, 累计 ${s.totalParsed} 题`,
            { sessionId, detail: { chunk_index: payload.chunk_index, total_chunks: payload.total_chunks, questions_in_chunk: payload.questions_in_chunk, total_parsed: payload.total_parsed } },
          );
          break;
        }
        case 'QuestionParsed': {
          const s = getOrCreateImport(sessionId);
          s.totalParsed = payload.total_parsed ?? s.totalParsed;
          const qContent = payload.question?.content;
          const preview = typeof qContent === 'string' ? qContent.slice(0, 60) : '';
          pushImportLog('debug', 'backend:question-parsed',
            `题目 #${payload.total_parsed}: ${preview}${preview.length >= 60 ? '...' : ''}`,
            { sessionId, detail: { question_index: payload.question_index, total_parsed: payload.total_parsed, question_type: payload.question?.question_type } },
          );
          break;
        }
        case 'Completed': {
          const s = getOrCreateImport(payload.session_id || sessionId);
          s.completedAt = Date.now();
          const totalMs = s.startAt ? s.completedAt - s.startAt : undefined;
          pushImportLog('success', 'backend:completed',
            `★ 导入完成: ${payload.name || '?'} | ${payload.total_questions ?? 0} 道题目 | 总耗时 ${totalMs ?? '?'}ms`,
            { sessionId: payload.session_id || sessionId, durationMs: totalMs, detail: { name: payload.name, total_questions: payload.total_questions } },
          );
          emitImportSummary(s);
          break;
        }
        case 'Failed': {
          const s = getOrCreateImport(payload.session_id || sessionId);
          s.failedAt = Date.now();
          pushImportLog('error', 'backend:failed',
            `导入失败: ${payload.error} | 已解析 ${payload.total_parsed ?? 0} 题`,
            { sessionId: payload.session_id || sessionId, detail: { error: payload.error, total_parsed: payload.total_parsed } },
          );
          emitImportSummary(s);
          break;
        }
        default:
          pushImportLog('debug', 'system', `未知事件类型: ${type}`, { sessionId, detail: payload });
      }
    });
    pushImportLog('info', 'system', 'Tauri question_import_progress 监听器已注册');
  } catch (err) {
    pushImportLog('error', 'system', `Tauri 监听器注册失败: ${err}`);
  }
}

// 模块加载时即注册
if (typeof window !== 'undefined') {
  attachTauriListener();
}

// ============================================================================
// UI 常量
// ============================================================================

const LEVEL_COLORS: Record<ImportLogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  success: '#10b981',
  warn: '#f59e0b',
  error: '#ef4444',
};

const LEVEL_ICONS: Record<ImportLogLevel, React.FC<any>> = {
  debug: Pulse,
  info: Lightning,
  success: CheckCircle,
  warn: Warning,
  error: XCircle,
};

const PHASE_LABELS: Record<ImportLogPhase, string> = {
  'frontend:invoke-start': '发起导入',
  'frontend:invoke-end': '调用返回',
  'backend:preprocessing': '预处理',
  'backend:rendering-pages': '页面渲染',
  'backend:ocr-image': 'VLM/OCR',
  'backend:ocr-phase-done': 'OCR完成',
  'backend:extracting-figs': '配图提取',
  'backend:structuring': 'LLM结构化',
  'backend:session-created': '会话创建',
  'backend:chunk-start': '块开始',
  'backend:chunk-completed': '块完成',
  'backend:question-parsed': '题目解析',
  'backend:completed': '★ 完成',
  'backend:failed': '✗ 失败',
  'anomaly:stuck': '⚠ 卡住',
  'anomaly:progress-regress': '⚠ 进度回退',
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

function buildCopyText(logs: ImportLogEntry[]): string {
  const lines = logs.map((l) => {
    const parts = [
      formatTs(l.ts),
      `[${l.level.toUpperCase()}]`,
      `[${l.phase}]`,
    ];
    if (l.sessionId) parts.push(`sid=${l.sessionId.slice(0, 16)}`);
    if (l.percent != null) parts.push(`${l.percent}%`);
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

const QuestionImportDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [logs, setLogs] = useState<ImportLogEntry[]>(snapshotLogs);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<ImportLogLevel | 'all'>('all');
  const [phaseFilter, setPhaseFilter] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // 订阅全局日志
  useEffect(() => {
    if (!isActivated) return;
    setLogs(snapshotLogs());
    const handler = (_entry: ImportLogEntry) => {
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
    const questions = logs.filter((l) => l.phase === 'backend:question-parsed').length;
    return { total, errors, warnings, anomalies, completed, questions };
  }, [logs]);

  const handleClear = useCallback(() => {
    clearLogs();
    inflightImports.clear();
    setLogs([]);
    setExpandedIds(new Set());
    pushImportLog('info', 'system', '日志已清空');
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
    a.download = `question-import-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
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
        <FileText size={14} style={{ color: '#3b82f6' }} />
        <span style={{ fontWeight: 600 }}>题目导入调试</span>
        <span style={{ color: '#6b7280' }}>共 {stats.total}</span>
        {stats.completed > 0 && <span style={{ color: '#10b981', fontWeight: 600 }}>✓ {stats.completed} 完成</span>}
        {stats.questions > 0 && <span style={{ color: '#6366f1', fontWeight: 600 }}>{stats.questions} 题</span>}
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
          <option value="backend:preprocessing">预处理</option>
          <option value="backend:ocr">VLM/OCR</option>
          <option value="backend:chunk">LLM分块</option>
          <option value="backend:question">题目</option>
          <option value="backend:completed">完成/失败</option>
          <option value="backend:">全部后端</option>
          <option value="frontend:">前端状态</option>
          <option value="anomaly:">⚠ 异常</option>
          <option value="system">系统</option>
        </select>
        <span style={{ color: '#6b7280', fontSize: 11 }}>({filteredLogs.length})</span>
      </div>

      {/* 日志列表 */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 0 }}>
        {filteredLogs.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#6b7280', padding: 24 }}>
            {isActivated ? '等待题目导入事件... 上传文档即可开始监控' : '请先激活此插件'}
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
                        : entry.phase === 'backend:session-created'
                          ? 'rgba(59, 130, 246, 0.04)'
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
                          : entry.phase === 'backend:session-created'
                            ? '#dbeafe'
                            : 'var(--muted)',
                    color: entry.phase === 'backend:completed'
                      ? '#065f46'
                      : entry.phase === 'backend:failed'
                        ? '#991b1b'
                        : entry.phase.startsWith('anomaly:')
                          ? '#92400e'
                          : entry.phase === 'backend:session-created'
                            ? '#1e40af'
                            : '#6b7280',
                  }}>
                    {PHASE_LABELS[entry.phase] || entry.phase}
                  </span>
                  {entry.percent != null && (
                    <span style={{ flexShrink: 0, color: '#8b5cf6', fontSize: 10, fontWeight: 600 }}>
                      {entry.percent}%
                    </span>
                  )}
                  {entry.durationMs != null && (
                    <span style={{ flexShrink: 0, color: entry.durationMs > 60000 ? '#ef4444' : entry.durationMs > 20000 ? '#f59e0b' : '#6b7280', fontSize: 10 }}>
                      <Clock size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 1 }} />
                      {entry.durationMs > 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs}ms`}
                    </span>
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground)' }}>
                    {entry.summary}
                  </span>
                </div>
                {/* 会话 ID */}
                {entry.sessionId && entry.sessionId !== '?' && (
                  <div style={{ marginLeft: 16, display: 'flex', gap: 8, fontSize: 10, color: '#9ca3af' }}>
                    <span>sid={entry.sessionId.slice(0, 20)}</span>
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

export default QuestionImportDebugPlugin;
