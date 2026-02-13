/**
 * ChatAnki 全链路工作流调试插件
 *
 * 监控整个 ChatAnki 制卡流程：
 * 1. chatanki_run/start 工具调用（输入参数 + 返回的 ankiBlockId / documentId）
 * 2. 后端 anki_generation_event 事件（DocumentProcessingStarted / NewCard / TaskCompleted 等）
 * 3. chatanki_wait/status/control 工具调用及返回值
 * 4. 前端 anki_cards block 状态变化
 * 5. 导出操作
 *
 * 每条日志包含精确时间戳、阶段、关键 ID（documentId / blockId / taskId），
 * 支持一键复制全部日志用于 bug 报告。
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Copy, Trash2, Download, ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';

// ============================================================================
// 类型
// ============================================================================

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type LogPhase =
  | 'tool:run'        // chatanki_run 调用
  | 'tool:start'      // chatanki_start 调用
  | 'tool:wait'       // chatanki_wait 调用
  | 'tool:status'     // chatanki_status 调用
  | 'tool:control'    // chatanki_control 调用
  | 'tool:export'     // chatanki_export 调用
  | 'tool:sync'       // chatanki_sync 调用
  | 'backend:event'   // 后端 anki_generation_event
  | 'bridge:event'    // 前后端桥接事件（chat_v2_event -> store）
  | 'block:state'     // block 状态变化
  | 'bridge:card'     // TauriAdapter 桥接卡片到块
  | 'render:stack'    // 前端卡片堆栈渲染
  | 'render:card3d'   // 3D 渲染层行为
  | 'template:load'   // 多模板加载
  | 'template:resolve'// 模板解析（per-card）
  | 'export:apkg'     // APKG 导出
  | 'db:query'        // DB 查询（list_document_sessions 等）
  | 'system';         // 系统事件

interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  phase: LogPhase;
  summary: string;
  detail?: unknown;
  documentId?: string;
  blockId?: string;
  taskId?: string;
}

const MAX_LOGS = 2000;
let logIdCounter = 0;

// ============================================================================
// 全局日志收集器（其他模块可调用 pushChatAnkiLog）
// ============================================================================

const globalLogs: LogEntry[] = [];
const globalListeners = new Set<(entry: LogEntry) => void>();

export function pushChatAnkiLog(
  level: LogLevel,
  phase: LogPhase,
  summary: string,
  opts?: { detail?: unknown; documentId?: string; blockId?: string; taskId?: string },
): void {
  const entry: LogEntry = {
    id: `cal-${++logIdCounter}`,
    ts: Date.now(),
    level,
    phase,
    summary,
    detail: opts?.detail,
    documentId: opts?.documentId,
    blockId: opts?.blockId,
    taskId: opts?.taskId,
  };
  globalLogs.push(entry);
  if (globalLogs.length > MAX_LOGS) globalLogs.splice(0, globalLogs.length - MAX_LOGS);
  globalListeners.forEach(fn => fn(entry));
}

function getSnapshot(): LogEntry[] {
  return globalLogs.slice();
}

function clearLogs(): void {
  globalLogs.length = 0;
}

// ============================================================================
// 全局事件桥接 — 任何模块都可以通过 window event 发日志，不依赖 require()
// ============================================================================

const LIFECYCLE_EVENT = 'chatanki-debug-lifecycle';

/**
 * 向调试插件发送生命周期日志（通过 window CustomEvent，无需 import）
 *
 * 使用方式（任何模块）：
 * ```ts
 * window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
 *   detail: { level: 'info', phase: 'bridge:card', summary: '...', documentId, blockId, detail: {...} }
 * }));
 * ```
 */
export function emitChatAnkiDebug(
  level: LogLevel,
  phase: LogPhase,
  summary: string,
  opts?: { detail?: unknown; documentId?: string; blockId?: string; taskId?: string },
): void {
  pushChatAnkiLog(level, phase, summary, opts);
  // 也通过 window event 广播（冗余但确保不丢）
  try {
    window.dispatchEvent(new CustomEvent(LIFECYCLE_EVENT, {
      detail: { level, phase, summary, ...opts },
    }));
  } catch { /* SSR safe */ }
}

const TOOL_INTERCEPT_EVENT = 'chatanki-debug-tool-intercept';

/** 在 chatanki_executor 的前端适配层调用此函数记录工具输入输出 */
export function interceptChatAnkiTool(
  toolName: string,
  direction: 'input' | 'output' | 'error',
  data: unknown,
  ids?: { documentId?: string; blockId?: string },
): void {
  const phase = toolNameToPhase(toolName);
  const level: LogLevel = direction === 'error' ? 'error' : 'info';
  const prefix = direction === 'input' ? '→' : direction === 'output' ? '←' : '✗';
  const summary = `${prefix} ${toolName} ${direction}`;

  pushChatAnkiLog(level, phase, summary, {
    detail: data,
    documentId: ids?.documentId ?? extractDocumentId(data),
    blockId: ids?.blockId ?? extractBlockId(data),
  });
}

function toolNameToPhase(name: string): LogPhase {
  const stripped = name.replace(/^(builtin-|mcp_)/, '');
  const map: Record<string, LogPhase> = {
    chatanki_run: 'tool:run',
    chatanki_start: 'tool:start',
    chatanki_wait: 'tool:wait',
    chatanki_status: 'tool:status',
    chatanki_control: 'tool:control',
    chatanki_export: 'tool:export',
    chatanki_sync: 'tool:sync',
  };
  return map[stripped] ?? 'system';
}

function extractDocumentId(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    return (obj.documentId ?? obj.document_id) as string | undefined;
  }
  return undefined;
}

function extractBlockId(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    return (obj.ankiBlockId ?? obj.anki_block_id ?? obj.blockId) as string | undefined;
  }
  return undefined;
}

// ============================================================================
// 格式化
// ============================================================================

function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function logsToText(logs: LogEntry[]): string {
  return logs.map(e => {
    let line = `[${formatTs(e.ts)}] [${e.level.toUpperCase()}] [${e.phase}] ${e.summary}`;
    if (e.documentId) line += ` docId=${e.documentId}`;
    if (e.blockId) line += ` blkId=${e.blockId}`;
    if (e.taskId) line += ` taskId=${e.taskId}`;
    if (e.detail != null) line += `\n  ${stringify(e.detail).split('\n').join('\n  ')}`;
    return line;
  }).join('\n');
}

// ============================================================================
// 颜色
// ============================================================================

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'text-slate-500',
  info: 'text-slate-300',
  warn: 'text-amber-400',
  error: 'text-rose-400',
};

const PHASE_COLORS: Record<string, string> = {
  'tool:run': 'text-blue-400',
  'tool:start': 'text-blue-400',
  'tool:wait': 'text-purple-400',
  'tool:status': 'text-cyan-400',
  'tool:control': 'text-orange-400',
  'tool:export': 'text-emerald-400',
  'tool:sync': 'text-emerald-400',
  'backend:event': 'text-yellow-300',
  'bridge:event': 'text-violet-300',
  'block:state': 'text-pink-400',
  'bridge:card': 'text-lime-400',
  'render:stack': 'text-fuchsia-300',
  'render:card3d': 'text-fuchsia-400',
  'template:load': 'text-indigo-400',
  'template:resolve': 'text-indigo-300',
  'export:apkg': 'text-green-400',
  'db:query': 'text-teal-400',
  'system': 'text-slate-400',
};

// ============================================================================
// 组件
// ============================================================================

const ChatAnkiWorkflowDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  isActivated,
}) => {
  const [logs, setLogs] = useState<LogEntry[]>(() => getSnapshot());
  const [keyword, setKeyword] = useState('');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [phaseFilter, setPhaseFilter] = useState<LogPhase | 'all'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [copyMsg, setCopyMsg] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // 订阅全局日志
  useEffect(() => {
    if (!isActivated) return;
    setLogs(getSnapshot());
    const handler = (entry: LogEntry) => {
      setLogs(prev => {
        const next = [...prev, entry];
        if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
        return next;
      });
    };
    globalListeners.add(handler);
    pushChatAnkiLog('info', 'system', 'ChatAnki Workflow Debug 插件已激活');
    return () => {
      globalListeners.delete(handler);
    };
  }, [isActivated]);

  // 监听后端 anki_generation_event
  useEffect(() => {
    if (!isActivated) return;
    let unlisten: UnlistenFn | null = null;

    listen<unknown>('anki_generation_event', (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      // 解析事件类型
      let eventType = 'unknown';
      let docId: string | undefined;
      let taskId: string | undefined;
      let level: LogLevel = 'info';

      // 提取通用字段
      const extractIds = (d: Record<string, unknown>) => ({
        docId: (d.document_id ?? d.documentId) as string | undefined,
        taskId: (d.task_id ?? d.taskId) as string | undefined,
      });

      let summary = '';

      if ('DocumentProcessingStarted' in payload) {
        const d = payload.DocumentProcessingStarted as Record<string, unknown>;
        eventType = 'DocumentProcessingStarted';
        const ids = extractIds(d);
        docId = ids.docId;
        summary = `segments=${d.total_segments ?? '?'}`;
      } else if ('NewCard' in payload) {
        const d = payload.NewCard as Record<string, unknown>;
        const card = d.card as Record<string, unknown> | undefined;
        eventType = 'NewCard';
        const ids = extractIds(d);
        docId = ids.docId;
        taskId = card?.task_id as string | undefined;
        const templateId = card?.template_id ?? 'null';
        const front = ((card?.front as string) || '').slice(0, 40);
        summary = `template=${templateId} | "${front}"`;
        level = 'debug';
      } else if ('NewErrorCard' in payload) {
        const d = payload.NewErrorCard as Record<string, unknown>;
        const card = d.card as Record<string, unknown> | undefined;
        eventType = 'NewErrorCard';
        docId = extractIds(d).docId;
        const errorContent = ((card?.error_content as string) || '').slice(0, 80);
        summary = `截断内容: "${errorContent}"`;
        level = 'warn';
      } else if ('TaskCompleted' in payload) {
        const d = payload.TaskCompleted as Record<string, unknown>;
        eventType = 'TaskCompleted';
        const ids = extractIds(d);
        docId = ids.docId; taskId = ids.taskId;
        summary = `total_cards=${d.total_cards_generated ?? '?'} | status=${d.final_status ?? '?'}`;
      } else if ('TaskStatusUpdate' in payload) {
        const d = payload.TaskStatusUpdate as Record<string, unknown>;
        eventType = `TaskStatusUpdate(${d.status})`;
        const ids = extractIds(d);
        docId = ids.docId; taskId = ids.taskId;
        summary = `segment=${d.segment_index ?? '?'}`;
      } else if ('TaskProcessingError' in payload) {
        const d = payload.TaskProcessingError as Record<string, unknown>;
        eventType = 'TaskProcessingError';
        docId = extractIds(d).docId;
        summary = `error: ${(d.message ?? d.error ?? '?') as string}`;
        level = 'error';
      } else if ('DocumentProcessingCompleted' in payload) {
        const d = payload.DocumentProcessingCompleted as Record<string, unknown>;
        eventType = 'DocumentProcessingCompleted';
        docId = extractIds(d).docId;
      } else if ('DocumentProcessingPaused' in payload) {
        eventType = 'DocumentProcessingPaused';
      } else if ('RateLimitWarning' in payload) {
        eventType = 'RateLimitWarning';
        level = 'warn';
      } else if ('WorkflowFailed' in payload) {
        const d = payload.WorkflowFailed as Record<string, unknown>;
        eventType = 'WorkflowFailed';
        docId = extractIds(d).docId;
        summary = `error: ${(d.message ?? d.error ?? '?') as string}`;
        level = 'error';
      } else {
        eventType = Object.keys(payload)[0] ?? 'unknown';
      }

      pushChatAnkiLog(level, 'backend:event', `${eventType}${summary ? ' | ' + summary : ''}`, {
        detail: payload,
        documentId: docId,
        taskId,
      });
    }).then(fn => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, [isActivated]);

  // 监听工具拦截事件（旧机制）
  useEffect(() => {
    if (!isActivated) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        interceptChatAnkiTool(
          detail.toolName,
          detail.direction,
          detail.data,
          detail.ids,
        );
      }
    };
    window.addEventListener(TOOL_INTERCEPT_EVENT, handler);
    return () => window.removeEventListener(TOOL_INTERCEPT_EVENT, handler);
  }, [isActivated]);

  // 监听所有 chat_v2 块级事件 — 捕获 tool_call start/end 中的 chatanki 工具
  useEffect(() => {
    if (!isActivated) return;
    let unlisten: UnlistenFn | null = null;

    // 监听所有 chat_v2_event_* 通道（通配符不支持，改为监听 window 转发）
    // TauriAdapter 已经在 handleBlockEvent 中处理，这里通过全局事件拦截
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d || !d.type) return;
      const eventType: string = d.type;
      const toolName: string = d.toolName || d.payload?.toolName || '';

      // 只关注 chatanki 相关的工具调用
      if (!toolName.includes('chatanki') && !eventType.includes('anki_cards')) return;

      const phase = d.phase || 'start';
      const blockId = d.blockId;
      const toolInput = d.toolInput || d.payload?.toolInput;
      const toolOutput = d.toolOutput || d.result;

      if (phase === 'start' && toolInput) {
        const maxCards = toolInput.maxCards ?? toolInput.max_cards ?? 'NOT_SET';
        const goal = ((toolInput.goal as string) || '').slice(0, 60);
        pushChatAnkiLog('info', toolNameToPhase(toolName), `→ ${toolName} | maxCards=${maxCards} | goal="${goal}"`, {
          detail: toolInput,
          blockId,
          documentId: toolInput.documentId ?? toolInput.document_id,
        });
      } else if (phase === 'end' && toolOutput) {
        const status = (toolOutput as any)?.status ?? 'ok';
        const ankiBlockId = (toolOutput as any)?.ankiBlockId;
        const documentId = (toolOutput as any)?.documentId;
        const cardsCount = (toolOutput as any)?.cardsCount;
        pushChatAnkiLog(
          status === 'error' ? 'error' : 'info',
          toolNameToPhase(toolName),
          `← ${toolName} | status=${status}${ankiBlockId ? ' | blk=' + ankiBlockId.slice(0, 12) : ''}${documentId ? ' | doc=' + documentId.slice(0, 12) : ''}${cardsCount != null ? ' | cards=' + cardsCount : ''}`,
          { detail: toolOutput, blockId, documentId },
        );
      } else if (phase === 'error') {
        pushChatAnkiLog('error', toolNameToPhase(toolName), `✗ ${toolName} FAILED: ${d.error || 'unknown'}`, {
          detail: d, blockId,
        });
      }
    };
    window.addEventListener('chatanki-debug-tool-block', handler);
    return () => window.removeEventListener('chatanki-debug-tool-block', handler);
  }, [isActivated]);

  // 监听生命周期事件（新机制 — 通过 window CustomEvent 桥接，不依赖 require()）
  useEffect(() => {
    if (!isActivated) return;
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d) return;
      // 避免重复：pushChatAnkiLog 已经在 emitChatAnkiDebug 内部调了一次
      // 这里只处理外部直接 dispatchEvent 但没走 emitChatAnkiDebug 的情况
      // 用 _fromEmit 标记区分
      if (d._fromEmit) return;
      pushChatAnkiLog(
        d.level ?? 'info',
        d.phase ?? 'system',
        d.summary ?? '',
        { detail: d.detail, documentId: d.documentId, blockId: d.blockId, taskId: d.taskId },
      );
    };
    window.addEventListener(LIFECYCLE_EVENT, handler);
    return () => window.removeEventListener(LIFECYCLE_EVENT, handler);
  }, [isActivated]);

  // 自动滚动
  useEffect(() => {
    if (!autoScroll || !isActivated) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll, isActivated]);

  // 过滤
  const filtered = useMemo(() => {
    return logs.filter(e => {
      if (levelFilter !== 'all' && e.level !== levelFilter) return false;
      if (phaseFilter !== 'all' && e.phase !== phaseFilter) return false;
      if (keyword.trim()) {
        const q = keyword.trim().toLowerCase();
        const hay = `${e.phase} ${e.summary} ${e.documentId ?? ''} ${e.blockId ?? ''} ${e.taskId ?? ''} ${stringify(e.detail)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [logs, levelFilter, phaseFilter, keyword]);

  // 复制日志
  const handleCopy = useCallback(async () => {
    const text = logsToText(filtered);
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg(`已复制 ${filtered.length} 条日志`);
      setTimeout(() => setCopyMsg(''), 2000);
    } catch {
      setCopyMsg('复制失败');
      setTimeout(() => setCopyMsg(''), 2000);
    }
  }, [filtered]);

  // 下载日志
  const handleDownload = useCallback(() => {
    const text = logsToText(filtered);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chatanki-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  // 切换展开
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // 统计 documentId 出现频次
  const docIds = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of logs) {
      if (e.documentId) map.set(e.documentId, (map.get(e.documentId) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [logs]);

  if (!isActivated) return null;

  return (
    <div className="flex flex-col h-full bg-slate-950/95 text-slate-100">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/70 text-xs flex-wrap">
        <span className="font-semibold tracking-wide text-sky-400">ChatAnki Workflow</span>
        <span className="text-slate-500">{logs.length} events</span>

        {/* Document ID 快速跳转 */}
        {docIds.length > 0 && (
          <div className="flex items-center gap-1 ml-2">
            <span className="text-[10px] text-slate-500">docIds:</span>
            {docIds.slice(0, 3).map(([id, count]) => (
              <button
                key={id}
                type="button"
                className="text-[9px] bg-slate-800 px-1.5 py-0.5 rounded font-mono hover:bg-slate-700 truncate max-w-[100px]"
                title={id}
                onClick={() => setKeyword(id.slice(0, 12))}
              >
                {id.slice(0, 8)}… ({count})
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          <label className="inline-flex items-center gap-1 text-[10px] text-slate-400">
            <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>

          <select
            className="bg-slate-900 border border-slate-700 text-[10px] px-1.5 py-0.5 rounded"
            value={levelFilter}
            onChange={e => setLevelFilter(e.target.value as LogLevel | 'all')}
          >
            <option value="all">全部级别</option>
            <option value="debug">DEBUG</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
          </select>

          <select
            className="bg-slate-900 border border-slate-700 text-[10px] px-1.5 py-0.5 rounded"
            value={phaseFilter}
            onChange={e => setPhaseFilter(e.target.value as LogPhase | 'all')}
          >
            <option value="all">全部阶段</option>
            <option value="tool:run">tool:run</option>
            <option value="tool:start">tool:start</option>
            <option value="tool:wait">tool:wait</option>
            <option value="tool:status">tool:status</option>
            <option value="tool:control">tool:control</option>
            <option value="tool:export">tool:export</option>
            <option value="backend:event">backend:event</option>
            <option value="bridge:event">bridge:event</option>
            <option value="bridge:card">bridge:card</option>
            <option value="block:state">block:state</option>
            <option value="render:stack">render:stack</option>
            <option value="render:card3d">render:card3d</option>
            <option value="template:load">template:load</option>
            <option value="template:resolve">template:resolve</option>
            <option value="export:apkg">export:apkg</option>
            <option value="system">system</option>
          </select>

          <div className="relative">
            <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-600" />
            <input
              className="bg-slate-900 border border-slate-700 text-[10px] pl-5 pr-5 py-0.5 rounded w-[120px]"
              placeholder="搜索..."
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
            />
            {keyword && (
              <button
                type="button"
                className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                onClick={() => setKeyword('')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <button
            type="button"
            className="text-[10px] bg-sky-800 hover:bg-sky-700 border border-sky-600 rounded px-2 py-0.5 flex items-center gap-1"
            onClick={handleCopy}
            title="复制全部日志到剪贴板"
          >
            <Copy className="h-3 w-3" />
            {copyMsg || '复制'}
          </button>
          <button
            type="button"
            className="text-[10px] bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded px-2 py-0.5 flex items-center gap-1"
            onClick={handleDownload}
            title="下载日志文件"
          >
            <Download className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="text-[10px] bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded px-2 py-0.5 flex items-center gap-1"
            onClick={() => { clearLogs(); setLogs([]); }}
          >
            <Trash2 className="h-3 w-3" />
            清空
          </button>
        </div>
      </div>

      {/* 日志列表 */}
      <div
        ref={listRef}
        className="flex-1 overflow-auto px-2 py-1 space-y-px"
        style={{ fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace' }}
      >
        {filtered.length === 0 && (
          <div className="text-slate-600 text-[11px] py-4 text-center">
            暂无日志 — 在聊天中发起制卡即可看到完整工作流日志
          </div>
        )}
        {filtered.map(entry => {
          const isExpanded = expandedIds.has(entry.id);
          const hasDetail = entry.detail != null;

          return (
            <div
              key={entry.id}
              className={`rounded px-2 py-1 ${entry.level === 'error' ? 'bg-rose-950/30 border border-rose-900/30' : entry.level === 'warn' ? 'bg-amber-950/20 border border-amber-900/20' : 'bg-slate-900/50 hover:bg-slate-900/70'}`}
            >
              <div
                className="flex items-center gap-2 text-[10px] cursor-pointer select-none"
                onClick={() => hasDetail && toggleExpand(entry.id)}
              >
                {/* 展开箭头 */}
                <span className="w-3 flex-shrink-0 text-slate-600">
                  {hasDetail ? (
                    isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
                  ) : null}
                </span>
                {/* 时间 */}
                <span className="text-slate-500 tabular-nums flex-shrink-0">{formatTs(entry.ts)}</span>
                {/* 级别 */}
                <span className={`uppercase w-[38px] flex-shrink-0 font-semibold ${LEVEL_COLORS[entry.level]}`}>
                  {entry.level}
                </span>
                {/* 阶段 */}
                <span className={`w-[100px] flex-shrink-0 truncate ${PHASE_COLORS[entry.phase] ?? 'text-slate-400'}`}>
                  {entry.phase}
                </span>
                {/* 摘要 */}
                <span className="text-slate-200 flex-1 truncate">{entry.summary}</span>
                {/* IDs */}
                {entry.documentId && (
                  <span className="text-[9px] text-teal-600 font-mono truncate max-w-[80px] flex-shrink-0" title={entry.documentId}>
                    doc:{entry.documentId.slice(0, 8)}
                  </span>
                )}
                {entry.blockId && (
                  <span className="text-[9px] text-purple-600 font-mono truncate max-w-[80px] flex-shrink-0" title={entry.blockId}>
                    blk:{entry.blockId.slice(0, 8)}
                  </span>
                )}
              </div>

              {/* 展开详情 */}
              {isExpanded && hasDetail && (
                <div className="mt-1 ml-5 relative">
                  <pre className="text-[10px] text-slate-400 whitespace-pre-wrap break-all max-h-[300px] overflow-auto">
                    {stringify(entry.detail)}
                  </pre>
                  <button
                    type="button"
                    className="absolute top-0 right-0 text-[9px] bg-slate-800 hover:bg-slate-700 px-1.5 py-0.5 rounded border border-slate-700"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(stringify(entry.detail));
                      } catch { /* ignore */ }
                    }}
                  >
                    复制
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ChatAnkiWorkflowDebugPlugin;
