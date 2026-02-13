import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollText, Copy, Check, Trash2, Play, Pause, AlertTriangle } from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  NOTES_OUTLINE_DEBUG_EVENT,
  type OutlineDebugEventDetail,
  type OutlineDebugLogPayload,
  type OutlineScrollSnapshot,
} from '../events/NotesOutlineDebugChannel';

interface DebugLogEntry extends OutlineDebugLogPayload {
  id: string;
  timestamp: number;
}

const MAX_LOGS = 200;
const MAX_SNAPSHOTS = 30;

export default function NotesOutlineDebugPlugin({ isActive }: DebugPanelPluginProps) {
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [snapshots, setSnapshots] = useState<OutlineScrollSnapshot[]>([]);
  const [filter, setFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | OutlineDebugLogPayload['category']>('all');
  const [copied, setCopied] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const handleDebugEvent = useCallback((event: CustomEvent<OutlineDebugEventDetail>) => {
    if (pausedRef.current) return;
    const detail = event.detail;
    if (detail.type === 'log') {
      setLogs(prev => [
        {
          ...detail.payload,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
        },
        ...prev,
      ].slice(0, MAX_LOGS));
    }
    if (detail.type === 'snapshot') {
      setSnapshots(prev => [
        { ...detail.payload, timestamp: detail.payload.timestamp ?? Date.now() },
        ...prev,
      ].slice(0, MAX_SNAPSHOTS));
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const listener = (e: Event) => handleDebugEvent(e as CustomEvent<OutlineDebugEventDetail>);
    window.addEventListener(NOTES_OUTLINE_DEBUG_EVENT, listener);
    return () => window.removeEventListener(NOTES_OUTLINE_DEBUG_EVENT, listener);
  }, [handleDebugEvent, isActive]);

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      if (categoryFilter !== 'all' && log.category !== categoryFilter) return false;
      if (!filter.trim()) return true;
      const text = `${log.action} ${JSON.stringify(log.details ?? {})}`.toLowerCase();
      return text.includes(filter.toLowerCase());
    });
  }, [logs, categoryFilter, filter]);

  const copyAll = useCallback(() => {
    const payload = {
      logs,
      snapshots,
      exportedAt: new Date().toISOString(),
    };
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [logs, snapshots]);

  const clearAll = useCallback(() => {
    setLogs([]);
    setSnapshots([]);
  }, []);

  return (
    <div className="flex flex-col gap-3 h-full overflow-hidden">
      <div className="flex items-center gap-2">
        <ScrollText className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">大纲滚动调试</span>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <button
            className="px-2 py-1 rounded bg-muted hover:bg-muted/70"
            onClick={() => setPaused(p => !p)}
          >
            {paused ? (
              <span className="flex items-center gap-1"><Play className="w-3 h-3" /> 继续</span>
            ) : (
              <span className="flex items-center gap-1"><Pause className="w-3 h-3" /> 暂停</span>
            )}
          </button>
          <button
            className="px-2 py-1 rounded bg-muted hover:bg-muted/70"
            onClick={copyAll}
          >
            <span className="flex items-center gap-1">
              {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}复制日志
            </span>
          </button>
          <button className="px-2 py-1 rounded bg-muted hover:bg-muted/70" onClick={clearAll}>
            <span className="flex items-center gap-1"><Trash2 className="w-3 h-3" /> 清空</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <input
          className="px-2 py-1 rounded border bg-background flex-1 min-w-[120px]"
          placeholder="关键字过滤"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <select
          className="px-2 py-1 rounded border bg-background"
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value as typeof categoryFilter)}
        >
          <option value="all">全部类别</option>
          <option value="outline">Outline</option>
          <option value="event">Event</option>
          <option value="editor">Editor</option>
          <option value="scroll">Scroll</option>
          <option value="dom">DOM</option>
          <option value="error">Error</option>
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 overflow-hidden">
        <div className="flex flex-col border rounded-lg overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold bg-muted/40">实时日志（{filteredLogs.length}）</div>
          <div className="flex-1 overflow-auto text-xs divide-y">
            {filteredLogs.length === 0 && (
              <div className="p-4 text-muted-foreground/60 text-center text-xs">暂无日志</div>
            )}
            {filteredLogs.map(log => (
              <div key={log.id} className="p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{log.action}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60">
                    {log.category}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                {log.details && (
                  <pre className="bg-muted/30 rounded p-2 text-[10px] whitespace-pre-wrap">
                    {JSON.stringify(log.details, null, 2)}
                  </pre>
                )}
                {log.level === 'warn' && (
                  <div className="flex items-center gap-1 text-amber-500 text-[10px]">
                    <AlertTriangle className="w-3 h-3" /> Warning
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col border rounded-lg overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold bg-muted/40">状态快照（{snapshots.length}）</div>
          <div className="flex-1 overflow-auto text-xs divide-y">
            {snapshots.length === 0 && (
              <div className="p-4 text-muted-foreground/60 text-center text-xs">暂无快照</div>
            )}
            {snapshots.map((snapshot, idx) => (
              <div key={`${snapshot.timestamp}-${idx}`} className="p-3 space-y-2">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{snapshot.noteId ?? '未选择笔记'}</span>
                  <span>{snapshot.timestamp ? new Date(snapshot.timestamp).toLocaleTimeString() : ''}</span>
                </div>
                <pre className="bg-muted/30 rounded p-2 text-[10px] whitespace-pre-wrap">
                  {JSON.stringify(snapshot, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
