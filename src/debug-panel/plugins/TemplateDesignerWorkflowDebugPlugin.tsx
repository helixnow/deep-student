import { copyTextToClipboard } from '@/utils/clipboardUtils';

/**
 * 模板设计师全链路调试插件
 *
 * 监控 template_designer 相关工具调用、块状态变化与模板渲染生命周期。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Search, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  TEMPLATE_DESIGNER_LIFECYCLE_EVENT,
  TEMPLATE_DESIGNER_TOOL_EVENT,
  buildTemplateToolSummary,
  isTemplateDesignerToolName,
  toTemplateDebugPhase,
  type TemplateDebugLevel,
  type TemplateDebugPhase,
} from '@/chat-v2/debug/templateDesignerDebug';

type LogEntry = {
  id: string;
  ts: number;
  level: TemplateDebugLevel;
  phase: TemplateDebugPhase;
  summary: string;
  detail?: unknown;
  templateId?: string;
  blockId?: string;
};

type ToolEventDetail = {
  type?: string;
  phase?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  result?: unknown;
  error?: string;
  blockId?: string;
  payload?: unknown;
};

type InflightRecord = {
  toolCallId: string;
  toolName: string;
  templateId?: string;
  blockId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  stage: 'preparing' | 'approval' | 'running';
  approvalTimeoutMs?: number;
  warnedPrepareTimeout?: boolean;
  warnedApprovalTimeout?: boolean;
  warnedRunTimeout?: boolean;
};

const MAX_LOGS = 2000;
const PREPARE_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 60_000;
let logCounter = 0;

const globalLogs: LogEntry[] = [];
const globalListeners = new Set<(entry: LogEntry) => void>();

function pushLog(entry: Omit<LogEntry, 'id' | 'ts'>): void {
  const finalEntry: LogEntry = {
    id: `tdw-${++logCounter}`,
    ts: Date.now(),
    ...entry,
  };
  globalLogs.push(finalEntry);
  if (globalLogs.length > MAX_LOGS) {
    globalLogs.splice(0, globalLogs.length - MAX_LOGS);
  }
  globalListeners.forEach((listener) => listener(finalEntry));
}

function snapshotLogs(): LogEntry[] {
  return globalLogs.slice();
}

function clearLogs(): void {
  globalLogs.length = 0;
}

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

function formatSummary(summary: string, templateId?: string): string {
  if (!summary || !templateId) return summary;
  if (summary.includes(`templateId=${templateId}`)) return summary;
  return `${summary} | templateId=${templateId}`;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function parseToolCallId(detail: ToolEventDetail): string | undefined {
  const payload = toRecord(detail.payload);
  const direct = payload?.toolCallId;
  if (typeof direct === 'string' && direct.trim()) return direct;

  const input = toRecord(detail.toolInput);
  const inputId = input?.toolCallId;
  if (typeof inputId === 'string' && inputId.trim()) return inputId;

  const blockId = detail.blockId;
  if (typeof blockId === 'string' && blockId.startsWith('approval_')) {
    return blockId.slice('approval_'.length);
  }
  return undefined;
}

function parseApprovalTimeoutMs(detail: ToolEventDetail): number | undefined {
  const payload = toRecord(detail.payload);
  const timeoutSeconds = payload?.timeoutSeconds;
  if (typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return timeoutSeconds * 1000;
  }
  return undefined;
}

function resolveStage(detail: ToolEventDetail): InflightRecord['stage'] {
  if (detail.type === 'tool_call_preparing') return 'preparing';
  if (detail.type === 'tool_approval_request') return 'approval';
  return 'running';
}

function toPlainText(logs: LogEntry[]): string {
  return logs
    .map((log) => {
      let line = `[${formatTs(log.ts)}] [${log.level.toUpperCase()}] [${log.phase}] ${log.summary}`;
      if (log.templateId && !log.summary.includes(`templateId=${log.templateId}`)) {
        line += ` templateId=${log.templateId}`;
      }
      if (log.blockId) line += ` blockId=${log.blockId}`;
      if (log.detail != null) line += `\n  ${stringify(log.detail).split('\n').join('\n  ')}`;
      return line;
    })
    .join('\n');
}

function normalizeToolEventDetail(detail: ToolEventDetail): ToolEventDetail {
  const normalized: ToolEventDetail = { ...detail };
  const output = detail.toolOutput;
  const result = detail.result;
  if (output != null && result != null) {
    try {
      if (JSON.stringify(output) === JSON.stringify(result)) {
        normalized.result = undefined;
      }
    } catch {
      // ignore compare failures, keep original payloads
    }
  }
  return normalized;
}

const TemplateDesignerWorkflowDebugPlugin: React.FC<DebugPanelPluginProps> = ({ isActivated }) => {
  const [logs, setLogs] = useState<LogEntry[]>(() => snapshotLogs());
  const [keyword, setKeyword] = useState('');
  const [levelFilter, setLevelFilter] = useState<TemplateDebugLevel | 'all'>('all');
  const [phaseFilter, setPhaseFilter] = useState<TemplateDebugPhase | 'all'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [copyMessage, setCopyMessage] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inflightRef = useRef<Map<string, InflightRecord>>(new Map());

  const removeInflightByBlockId = useCallback((blockId?: string) => {
    if (!blockId) return;
    const inflight = inflightRef.current;
    for (const [toolCallId, record] of inflight.entries()) {
      if (record.blockId === blockId) {
        inflight.delete(toolCallId);
      }
    }
  }, []);

  const updateInflight = useCallback((detail: ToolEventDetail, templateId?: string, rawToolName?: string) => {
    const toolCallId = parseToolCallId(detail);
    if (!toolCallId) return;

    const now = Date.now();
    const map = inflightRef.current;
    const existing = map.get(toolCallId);
    const nextStage = resolveStage(detail);
    const next: InflightRecord = existing
      ? {
          ...existing,
          toolName: rawToolName || existing.toolName,
          templateId: templateId ?? existing.templateId,
          blockId: detail.blockId ?? existing.blockId,
          lastSeenAt: now,
          stage: nextStage,
          approvalTimeoutMs: parseApprovalTimeoutMs(detail) ?? existing.approvalTimeoutMs,
        }
      : {
          toolCallId,
          toolName: rawToolName || '',
          templateId,
          blockId: detail.blockId,
          firstSeenAt: now,
          lastSeenAt: now,
          stage: nextStage,
          approvalTimeoutMs: parseApprovalTimeoutMs(detail),
        };

    map.set(toolCallId, next);
  }, []);

  useEffect(() => {
    if (!isActivated) return;
    setLogs(snapshotLogs());
    const onLog = (entry: LogEntry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
        return next;
      });
    };
    globalListeners.add(onLog);
    pushLog({
      level: 'info',
      phase: 'system',
      summary: '模板设计师监听插件已激活',
    });
    return () => {
      globalListeners.delete(onLog);
      inflightRef.current.clear();
    };
  }, [isActivated]);

  useEffect(() => {
    if (!isActivated) return;

    const onError = (event: ErrorEvent) => {
      pushLog({
        level: 'error',
        phase: 'system',
        summary: `window.error: ${event.message || 'unknown error'}`,
        detail: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error,
        },
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      pushLog({
        level: 'error',
        phase: 'system',
        summary: 'window.unhandledrejection',
        detail: {
          reason: event.reason,
        },
      });
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, [isActivated]);

  useEffect(() => {
    if (!isActivated) return;
    const handler = (event: Event) => {
      const detail = normalizeToolEventDetail((event as CustomEvent).detail as ToolEventDetail);
      const rawToolName = detail?.toolName || '';
      if (!isTemplateDesignerToolName(rawToolName)) return;

      const phase = detail.phase || 'start';
      const output = detail.toolOutput ?? detail.result;
      const templateId =
        extractId(detail.toolInput) ?? extractId(output) ?? extractId(detail.payload);
      const summary = formatSummary(
        buildTemplateToolSummary(rawToolName, phase, detail.toolInput, output, detail.error),
        templateId,
      );

      pushLog({
        level: phase === 'error' ? 'error' : 'info',
        phase: toTemplateDebugPhase(rawToolName),
        summary,
        detail,
        blockId: detail.blockId,
        templateId,
      });

      if (detail.type === 'tool_approval_request') {
        pushLog({
          level: 'warn',
          phase: toTemplateDebugPhase(rawToolName),
          summary: `⚠️ ${rawToolName} 进入审批，等待用户确认`,
          detail: {
            toolCallId: parseToolCallId(detail),
            timeoutMs: parseApprovalTimeoutMs(detail),
          },
          blockId: detail.blockId,
          templateId,
        });
      }

      if (phase === 'end' || phase === 'error') {
        const toolCallId = parseToolCallId(detail);
        if (toolCallId) inflightRef.current.delete(toolCallId);
        removeInflightByBlockId(detail.blockId);
        return;
      }

      updateInflight(detail, templateId, rawToolName);
    };

    window.addEventListener(TEMPLATE_DESIGNER_TOOL_EVENT, handler);
    return () => window.removeEventListener(TEMPLATE_DESIGNER_TOOL_EVENT, handler);
  }, [isActivated, removeInflightByBlockId, updateInflight]);

  useEffect(() => {
    if (!isActivated) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        level?: TemplateDebugLevel;
        phase?: TemplateDebugPhase;
        summary?: string;
        detail?: unknown;
        templateId?: string;
        blockId?: string;
      };
      if (!detail) return;

      pushLog({
        level: detail.level || 'info',
        phase: detail.phase || 'system',
        summary: detail.summary || 'template designer event',
        detail: detail.detail,
        templateId: detail.templateId,
        blockId: detail.blockId,
      });
    };

    window.addEventListener(TEMPLATE_DESIGNER_LIFECYCLE_EVENT, handler);
    return () => window.removeEventListener(TEMPLATE_DESIGNER_LIFECYCLE_EVENT, handler);
  }, [isActivated]);

  useEffect(() => {
    if (!isActivated) return;

    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const record of inflightRef.current.values()) {
        const ageMs = now - record.firstSeenAt;

        if (record.stage === 'preparing' && ageMs > PREPARE_TIMEOUT_MS && !record.warnedPrepareTimeout) {
          record.warnedPrepareTimeout = true;
          pushLog({
            level: 'warn',
            phase: toTemplateDebugPhase(record.toolName),
            summary: `⚠️ ${record.toolName} preparing 超时 ${Math.round(ageMs / 1000)}s（疑似未进入 tool_call）`,
            templateId: record.templateId,
            blockId: record.blockId,
            detail: { toolCallId: record.toolCallId, stage: record.stage, ageMs },
          });
        }

        if (record.stage === 'approval') {
          const approvalTimeout = record.approvalTimeoutMs ?? PREPARE_TIMEOUT_MS;
          if (ageMs > approvalTimeout && !record.warnedApprovalTimeout) {
            record.warnedApprovalTimeout = true;
            pushLog({
              level: 'warn',
              phase: toTemplateDebugPhase(record.toolName),
              summary: `⚠️ ${record.toolName} 审批等待超时 ${Math.round(ageMs / 1000)}s`,
              templateId: record.templateId,
              blockId: record.blockId,
              detail: {
                toolCallId: record.toolCallId,
                stage: record.stage,
                ageMs,
                timeoutMs: approvalTimeout,
              },
            });
          }
        }

        if (record.stage === 'running' && ageMs > RUN_TIMEOUT_MS && !record.warnedRunTimeout) {
          record.warnedRunTimeout = true;
          pushLog({
            level: 'warn',
            phase: toTemplateDebugPhase(record.toolName),
            summary: `⚠️ ${record.toolName} 执行超时 ${Math.round(ageMs / 1000)}s（疑似缺少 end/error）`,
            templateId: record.templateId,
            blockId: record.blockId,
            detail: {
              toolCallId: record.toolCallId,
              stage: record.stage,
              ageMs,
              timeoutMs: RUN_TIMEOUT_MS,
            },
          });
        }
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isActivated]);

  useEffect(() => {
    if (!autoScroll || !isActivated) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoScroll, isActivated, logs]);

  const filtered = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter !== 'all' && log.level !== levelFilter) return false;
      if (phaseFilter !== 'all' && log.phase !== phaseFilter) return false;
      if (keyword.trim()) {
        const q = keyword.trim().toLowerCase();
        const hay = `${log.phase} ${log.summary} ${log.templateId || ''} ${log.blockId || ''} ${stringify(log.detail)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [keyword, levelFilter, logs, phaseFilter]);

  const handleCopy = useCallback(async () => {
    const text = toPlainText(filtered);
    try {
      await copyTextToClipboard(text);
      setCopyMessage(`已复制 ${filtered.length} 条日志`);
      setTimeout(() => setCopyMessage(''), 2000);
    } catch {
      setCopyMessage('复制失败');
      setTimeout(() => setCopyMessage(''), 2000);
    }
  }, [filtered]);

  const handleDownload = useCallback(() => {
    const text = toPlainText(filtered);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `template-designer-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!isActivated) return null;

  return (
    <div className="flex flex-col h-full bg-slate-950/95 text-slate-100">
      <div className="px-3 py-2 border-b border-slate-800 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="w-full h-8 pl-8 pr-2 rounded bg-slate-900 border border-slate-700 text-xs"
            placeholder="搜索 tool/templateId/blockId"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        <select
          className="h-8 px-2 rounded bg-slate-900 border border-slate-700 text-xs"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as TemplateDebugLevel | 'all')}
        >
          <option value="all">全部级别</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>

        <select
          className="h-8 px-2 rounded bg-slate-900 border border-slate-700 text-xs"
          value={phaseFilter}
          onChange={(e) => setPhaseFilter(e.target.value as TemplateDebugPhase | 'all')}
        >
          <option value="all">全部阶段</option>
          <option value="tool:list">tool:list</option>
          <option value="tool:get">tool:get</option>
          <option value="tool:validate">tool:validate</option>
          <option value="tool:create">tool:create</option>
          <option value="tool:update">tool:update</option>
          <option value="tool:fork">tool:fork</option>
          <option value="tool:preview">tool:preview</option>
          <option value="tool:delete">tool:delete</option>
          <option value="block:state">block:state</option>
          <option value="render:template">render:template</option>
          <option value="system">system</option>
        </select>

        <button className="h-8 px-2 text-xs rounded bg-slate-800 hover:bg-slate-700" onClick={() => setAutoScroll((v) => !v)}>
          自动滚动: {autoScroll ? '开' : '关'}
        </button>
        <button className="h-8 px-2 text-xs rounded bg-slate-800 hover:bg-slate-700 inline-flex items-center gap-1" onClick={handleCopy}>
          <Copy className="w-3.5 h-3.5" /> 复制
        </button>
        <button className="h-8 px-2 text-xs rounded bg-slate-800 hover:bg-slate-700 inline-flex items-center gap-1" onClick={handleDownload}>
          <Download className="w-3.5 h-3.5" /> 下载
        </button>
        <button className="h-8 px-2 text-xs rounded bg-slate-800 hover:bg-slate-700 inline-flex items-center gap-1" onClick={() => { clearLogs(); setLogs([]); }}>
          <Trash2 className="w-3.5 h-3.5" /> 清空
        </button>
      </div>

      <div className="px-3 py-1 text-[11px] text-slate-400 border-b border-slate-800">
        日志 {filtered.length}/{logs.length}{copyMessage ? ` · ${copyMessage}` : ''}
      </div>

      <div ref={listRef} className="flex-1 overflow-auto p-2 font-mono text-[11px] space-y-1">
        {filtered.map((log) => {
          const expanded = expandedIds.has(log.id);
          const hasDetail = log.detail != null;
          return (
            <div key={log.id} className="rounded border border-slate-800 bg-slate-900/70">
              <button
                type="button"
                className="w-full flex items-center gap-1 px-2 py-1 text-left hover:bg-slate-800/80"
                onClick={() => hasDetail && toggleExpand(log.id)}
              >
                {hasDetail ? (expanded ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronRight className="w-3 h-3 text-slate-500" />) : <span className="w-3" />}
                <span className="text-slate-500">{formatTs(log.ts)}</span>
                <span className={log.level === 'error' ? 'text-rose-400' : log.level === 'warn' ? 'text-amber-400' : 'text-slate-300'}>[{log.level}]</span>
                <span className="text-indigo-300">[{log.phase}]</span>
                <span className="text-slate-100">{log.summary}</span>
                {log.templateId ? <span className="text-cyan-300">template={log.templateId}</span> : null}
                {log.blockId ? <span className="text-emerald-300">block={log.blockId.slice(0, 12)}</span> : null}
              </button>
              {expanded && hasDetail ? (
                <pre className="px-2 pb-2 whitespace-pre-wrap break-all text-slate-300">
                  {stringify(log.detail)}
                </pre>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

function extractId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const id = rec.templateId ?? rec.template_id ?? rec.usedTemplateId ?? rec.sourceTemplateId;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

export default TemplateDesignerWorkflowDebugPlugin;
