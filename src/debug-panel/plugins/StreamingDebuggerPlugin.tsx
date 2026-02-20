import React from 'react';
import { useTranslation } from 'react-i18next';
import { fileManager } from '../../utils/fileManager';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

type StreamEvent = {
  channel: string;
  eventName: string;
  payload: any;
  phase?: string | null;
  streamId?: string;
  targetMessageId?: string;
  ts: number;
};

export interface StreamingDebuggerPluginProps {
  visible: boolean;
  isActive: boolean;
  isActivated: boolean;
  onClose: () => void;
  currentStreamId?: string;
}

const STORAGE_KEYS = {
  MAX_BUFFER: 'DSTU_DBG_MAXBUF',
  VIEW_MODE: 'DSTU_DBG_VIEW',
  DISPLAY_LIMIT: 'DSTU_DBG_DISPLAY_LIMIT',
};

type ViewMode = 'raw' | 'event';

const sanitizeForExport = (input: any) => {
  try {
    return JSON.parse(JSON.stringify(input));
  } catch {
    return input;
  }
};

const sanitizeDebugPayload = (input: any) => {
  const MAX_INLINE = 200;
  const heavyKeys = new Set([
    'base64',
    'base64content',
    'text',
    'content',
    'textcontent',
    'text_content',
    'content_text',
    'raw_text',
    'rawcontent',
    'raw_content',
    'html',
  ]);

  const shouldRedactKey = (key: string) => {
    const lower = key.toLowerCase();
    if (heavyKeys.has(lower)) return true;
    if (lower.includes('base64') || lower.includes('dataurl') || lower.includes('data_url')) return true;
    return false;
  };

  const pathIncludesAttachment = (path: string[]) =>
    path.join('.').toLowerCase().includes('attachment');

  const redact = (value: any, path: string[]): any => {
    if (value == null) return value;
    if (typeof value === 'string') {
      if (shouldRedactKey(path[path.length - 1] || '') || (pathIncludesAttachment(path) && value.length > MAX_INLINE)) {
        return `[omitted ${value.length} chars]`;
      }
      if (value.length > MAX_INLINE) {
        return `[omitted ${value.length} chars]`;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, idx) => redact(item, path.concat(String(idx))));
    }
    if (typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        const lowerKey = key.toLowerCase();
        if (shouldRedactKey(lowerKey) && typeof val === 'string') {
          out[key] = `[omitted ${val.length} chars]`;
          continue;
        }
        if (Array.isArray(val) && (lowerKey.includes('attachments') || lowerKey.includes('files') || lowerKey.includes('documents'))) {
          out[key] = val.map((item, idx) => redact(item, path.concat(`${key}.${idx}`)));
          continue;
        }
        out[key] = redact(val, path.concat(key));
      }
      return out;
    }
    return value;
  };

  try {
    return redact(input, []);
  } catch {
    return input;
  }
};

const safeStringify = (obj: any): string => {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
};

const StreamingDebuggerPlugin: React.FC<StreamingDebuggerPluginProps> = ({
  visible,
  isActive,
  isActivated,
  onClose,
  currentStreamId,
}) => {
  const { t } = useTranslation('common');
  const [events, setEvents] = React.useState<StreamEvent[]>([]);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [maxBuf, setMaxBuf] = React.useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(STORAGE_KEYS.MAX_BUFFER) || '500', 10);
      if (!Number.isNaN(v)) return Math.min(10000, Math.max(200, v));
    } catch {}
    return 500;
  });
  const maxBufRef = React.useRef(maxBuf);
  React.useEffect(() => {
    maxBufRef.current = maxBuf;
    try {
      localStorage.setItem(STORAGE_KEYS.MAX_BUFFER, String(maxBuf));
    } catch {}
  }, [maxBuf]);

  const [droppedTotal, setDroppedTotal] = React.useState(0);
  const [displayLimit, setDisplayLimit] = React.useState<number>(() => {
    try {
      const val = parseInt(localStorage.getItem(STORAGE_KEYS.DISPLAY_LIMIT) || '200', 10);
      if (!Number.isNaN(val)) return val;
    } catch {}
    return 200;
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.DISPLAY_LIMIT, String(displayLimit));
    } catch {}
  }, [displayLimit]);
  const [samplingRate, setSamplingRate] = React.useState(1);
  const [channelFilter, setChannelFilter] = React.useState<Record<string, boolean>>({
    content: true,
    reasoning: true,
    rag: true,
    memory: true,
    patch: true,
    api_call: true,
    ui_action: true,
    config: true,
    error: true,
    tool: true,
    toolResult: true,
    usage: true,
    tauri_invoke: true,
    state: true,
  });
  const [onlyCurrent, setOnlyCurrent] = React.useState<boolean>(!!currentStreamId);
  const [text, setText] = React.useState('');
  const [viewMode, setViewMode] = React.useState<ViewMode>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.VIEW_MODE);
      return stored === 'event' ? 'event' : 'raw';
    } catch {
      return 'raw';
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.VIEW_MODE, viewMode);
    } catch {}
  }, [viewMode]);
  const [kindFilter, setKindFilter] = React.useState<'all' | 'state' | 'event'>('all');
  const [expandedKeys, setExpandedKeys] = React.useState<Set<string>>(() => new Set());
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [toolFilter, setToolFilter] = React.useState<'all' | 'success' | 'failed'>('all');
  const [allExpanded, setAllExpanded] = React.useState(false);
  const [searchFocus, setSearchFocus] = React.useState(false);

  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<StreamEvent>).detail;
      if (!detail) return;
      setEvents(prev => {
        const limit = maxBufRef.current;
        const next = [...prev, detail];
        let dropped = 0;
        while (next.length > limit) {
          next.shift();
          dropped += 1;
        }
        if (dropped > 0) {
          setDroppedTotal(v => v + dropped);
        }
        return next;
      });
    };

    window.addEventListener('DSTU_STREAM_EVENT', handler);
    return () => {
      window.removeEventListener('DSTU_STREAM_EVENT', handler);
    };
  }, []);

  React.useEffect(() => {
    if (!isActivated) return;
    if (!listRef.current) return;
    if (!(visible && isActive)) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [events.length, visible, isActive, isActivated]);

  const filteredRaw = React.useMemo(() => {
    return events.filter(ev => {
      if (!channelFilter[ev.channel]) return false;
      if (onlyCurrent && currentStreamId && ev.streamId && ev.streamId !== currentStreamId) return false;
      if (text.trim()) {
        const keyword = text.trim().toLowerCase();
        const haystack = `${ev.channel} ${ev.eventName || ''} ${JSON.stringify(ev.payload || {})} ${JSON.stringify(ev)}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }, [events, channelFilter, onlyCurrent, currentStreamId, text]);

  type TimelineEntry =
    | { kind: 'state'; ts: number; data: any; diff: any[]; key: string }
    | { kind: 'event'; ts: number; ev: StreamEvent };

  const timeline = React.useMemo<TimelineEntry[]>(() => {
    const out: TimelineEntry[] = [];
    let lastState: any = null;

    const includeEvent = (ev: StreamEvent) => {
      const detail = sanitizeDebugPayload(ev);
      out.push({ kind: 'event', ts: ev.ts, ev: detail });
    };

    const passesFilters = (ev: StreamEvent) => {
      if (!channelFilter[ev.channel]) return false;
      if (onlyCurrent && currentStreamId && ev.streamId && ev.streamId !== currentStreamId) return false;
      if (toolFilter !== 'all' && ev.channel === 'toolResult') {
        const success = ev.payload?.success !== false;
        if (toolFilter === 'success' && !success) return false;
        if (toolFilter === 'failed' && success) return false;
      }
      return true;
    };

    const addStateEntry = (payload: any, ts: number) => {
      const diff: any[] = [];
      if (lastState) {
        const keys = new Set([...Object.keys(lastState), ...Object.keys(payload)]);
        keys.forEach(key => {
          const prev = lastState[key];
          const next = payload[key];
          if (JSON.stringify(prev) !== JSON.stringify(next)) {
            diff.push({ path: [key], prev, value: next, type: prev === undefined ? 'add' : next === undefined ? 'remove' : 'change' });
          }
        });
      } else {
        diff.push({ path: [], value: payload, type: 'add' });
      }
      lastState = payload;
      out.push({ kind: 'state', ts, data: payload, diff, key: `state_${ts}` });
    };

    const sampledRaw = filteredRaw.filter((_, index) => (samplingRate <= 1 ? true : index % samplingRate === 0));

    sampledRaw.forEach(ev => {
      if (ev.channel === 'state') {
        if (passesFilters(ev)) {
          addStateEntry(ev.payload, ev.ts);
        }
      } else if (passesFilters(ev)) {
        includeEvent(ev);
      }
    });

    return out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }, [filteredRaw, channelFilter, onlyCurrent, currentStreamId, samplingRate, toolFilter]);

  const copyAll = React.useCallback((all: boolean) => {
    try {
      const data = all ? events : (viewMode === 'raw' ? filteredRaw : timeline);
      const text = JSON.stringify(data, null, 2);
      copyTextToClipboard(text);
    } catch {}
  }, [events, filteredRaw, timeline, viewMode]);

  const exportJson = React.useCallback(async (data: any, filename: string) => {
    try {
      const content = JSON.stringify(data, null, 2);
      const result = await fileManager.saveTextFile({
        title: '保存调试JSON',
        defaultFileName: filename,
        filters: [{ name: 'JSON', extensions: ['json'] }],
        content,
      });
      if (!result.canceled) return;
    } catch (e) {
      console.warn('save dialog failed, fallback to download', e);
    }
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {}
  }, []);

  const renderPayload = (mode: ViewMode, ev: any): string => {
    if (mode === 'raw') return safeStringify(ev.payload);
    try {
      const ch = ev.channel;
      if (ch === 'content') {
        const textContent = ev?.payload?.content || '';
        const len = textContent.length;
        const head = typeof textContent === 'string' ? textContent.slice(0, 180) : '';
        return `final=${!!ev?.payload?.is_complete}, len=${len}\n${head}${len > head.length ? `\n…(+${len - head.length})` : ''}`;
      }
      if (ch === 'reasoning') {
        const textContent = ev?.payload?.content || '';
        const len = textContent.length;
        return `reasoning(final=${!!ev?.payload?.is_complete}) len=${len} (content redacted)`;
      }
      if (ch === 'api_call') {
        const req = ev?.payload?.request || ev?.payload || {};
        return safeStringify(req);
      }
      if (ch === 'error') {
        const message = ev?.payload?.message || '';
        const stack = ev?.payload?.stack || '';
        return `Error: ${message}${stack ? `\nstack: ${String(stack).split('\n').slice(0, 5).join('\n')}` : ''}`;
      }
      return safeStringify(ev.payload);
    } catch {
      return safeStringify(ev.payload);
    }
  };

  const renderStateDiff = (diff: any[]) => {
    return diff.slice(0, 200).map((entry, index) => {
      const className = entry.type === 'add' ? 'dbg-diff-row add' : entry.type === 'remove' ? 'dbg-diff-row remove' : 'dbg-diff-row change';
      return (
        <div key={`${entry.type}-${index}`} className={className}>
          <span>{entry.type.toUpperCase()}</span> <code>{(entry.path || []).join('.')}</code>{' '}
          {entry.type === 'change' ? (
            <>
              <span>:</span> <code>{safeStringify(entry.prev)}</code> → <code>{safeStringify(entry.value)}</code>
            </>
          ) : entry.type === 'add' ? (
            <>
              <span>:</span> <code>{safeStringify(entry.value)}</code>
            </>
          ) : (
            <>
              <span>:</span> <code>{safeStringify(entry.prev)}</code>
            </>
          )}
        </div>
      );
    });
  };

  const currentTimeline = React.useMemo(() => {
    if (viewMode === 'event') {
      return timeline
        .filter(entry => (kindFilter === 'all' ? true : entry.kind === kindFilter))
        .filter(entry => {
          if (!errorsOnly) return true;
          if (entry.kind !== 'event') return false;
          return entry.ev.channel === 'error' || /error/i.test(String(entry.ev.eventName || ''));
        })
        .slice(0, displayLimit);
    }
    return filteredRaw.slice(0, displayLimit);
  }, [timeline, filteredRaw, viewMode, kindFilter, errorsOnly, displayLimit]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', padding: '4px 6px', borderBottom: '1px solid #1e293b' }}>
        <button
          onClick={() => setViewMode('raw')}
          style={{
            fontSize: 10,
            color: viewMode === 'raw' ? '#e2e8f0' : '#94a3b8',
            background: viewMode === 'raw' ? '#1f2937' : 'transparent',
            border: '1px solid #334155',
            borderRadius: 4,
            padding: '2px 6px',
            whiteSpace: 'nowrap',
          }}
        >
          {t('debug_panel.mode_data')}
        </button>
        <button
          onClick={() => setViewMode('event')}
          style={{
            fontSize: 10,
            color: viewMode === 'event' ? '#e2e8f0' : '#94a3b8',
            background: viewMode === 'event' ? '#1f2937' : 'transparent',
            border: '1px solid #334155',
            borderRadius: 4,
            padding: '2px 6px',
            whiteSpace: 'nowrap',
          }}
        >
          {t('debug_panel.mode_event')}
        </button>
        <span style={{ fontSize: 9, color: '#94a3b8' }}>{t('debug_panel.current_mode', { mode: viewMode === 'raw' ? t('debug_panel.mode_data') : t('debug_panel.mode_event') })}</span>
        <div style={{ flexGrow: 1 }} />
        <button
          onClick={() => setEvents([])}
          style={{ fontSize: 10, color: '#94a3b8', background: 'transparent', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px' }}
        >
          清空
        </button>
        <button
          onClick={() => copyAll(false)}
          style={{ fontSize: 10, color: '#94a3b8', background: 'transparent', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px' }}
        >
          复制筛选
        </button>
        <button
          onClick={() => copyAll(true)}
          style={{ fontSize: 10, color: '#94a3b8', background: 'transparent', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px' }}
        >
          复制全部
        </button>
        <button
          onClick={() => exportJson(viewMode === 'raw' ? filteredRaw : timeline, `dstu_debug_${currentStreamId || 'all'}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`)}
          style={{ fontSize: 10, color: '#e2e8f0', background: '#334155', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}
        >
          导出JSON
        </button>
        <select
          value={String(maxBuf)}
          onChange={e => setMaxBuf(Math.min(10000, Math.max(200, parseInt(e.target.value || '500', 10))))}
          style={{ fontSize: 10, color: '#e2e8f0', background: '#334155', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}
        >
          <option value="500">缓冲 500</option>
          <option value="1000">缓冲 1000</option>
          <option value="2000">缓冲 2000</option>
          <option value="5000">缓冲 5000</option>
          <option value="10000">缓冲 10000</option>
        </select>
      </div>

      <div className="dbg-toolbar" style={{ padding: '4px 6px', borderBottom: '1px solid #1e293b', display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {Object.keys(channelFilter).map(ch => (
          <label key={ch} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#cbd5e1', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={!!channelFilter[ch]} onChange={() => setChannelFilter(state => ({ ...state, [ch]: !state[ch] }))} style={{ width: 12, height: 12 }} /> {ch}
          </label>
        ))}
        <div style={{ display: 'flex', gap: 3, marginLeft: 4 }}>
          <label style={{ fontSize: 9, color: '#94a3b8' }}>工具:</label>
          <select
            value={toolFilter}
            onChange={e => setToolFilter(e.target.value as any)}
            style={{ fontSize: 9, background: '#334155', color: '#e2e8f0', border: '1px solid #475569', borderRadius: 3, padding: '1px 4px' }}
          >
            <option value="all">全部</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
          </select>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#cbd5e1', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={onlyCurrent} onChange={() => setOnlyCurrent(v => !v)} style={{ width: 12, height: 12 }} /> 只看当前流
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#cbd5e1', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={errorsOnly} onChange={() => setErrorsOnly(v => !v)} style={{ width: 12, height: 12 }} /> 仅错误
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#cbd5e1', whiteSpace: 'nowrap' }}>
          <span>采样</span>
          <select value={samplingRate} onChange={e => setSamplingRate(parseInt(e.target.value || '1', 10))} style={{ fontSize: 10, background: '#334155', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px' }}>
            <option value="1">全部</option>
            <option value="2">1/2</option>
            <option value="5">1/5</option>
            <option value="10">1/10</option>
          </select>
        </label>
        <input
          placeholder="搜索关键词/事件名/内容…"
          value={text}
          onChange={e => setText(e.target.value)}
          onFocus={() => setSearchFocus(true)}
          onBlur={() => setSearchFocus(false)}
          style={{
            flex: '1 1 180px',
            minWidth: 140,
            fontSize: 10,
            background: searchFocus ? '#1e293b' : '#0b1220',
            color: '#e2e8f0',
            border: searchFocus ? '1px solid #3b82f6' : '1px solid #334155',
            borderRadius: 4,
            padding: '2px 6px',
            transition: 'all 0.2s',
          }}
        />
        {currentStreamId && <span style={{ fontSize: 10, color: '#94a3b8', whiteSpace: 'nowrap' }}>当前流: {currentStreamId}</span>}
        {viewMode === 'event' && (
          <select value={kindFilter} onChange={e => setKindFilter((e.target.value as any) || 'all')} style={{ fontSize: 10, color: '#e2e8f0', background: '#334155', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}>
            <option value="all">显示：全部</option>
            <option value="state">只看状态点</option>
            <option value="event">只看事件</option>
          </select>
        )}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#cbd5e1', whiteSpace: 'nowrap' }}>
          <span>上限</span>
          <input
            type="number"
            value={displayLimit}
            min={50}
            max={2000}
            onChange={e => setDisplayLimit(Math.min(2000, Math.max(50, parseInt(e.target.value || '200', 10))))}
            style={{ width: 60, fontSize: 10, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px' }}
          />
        </label>
        <button
          onClick={() => {
            if (viewMode !== 'event') return;
            const base = timeline.filter(entry => (kindFilter === 'all' ? true : entry.kind === kindFilter));
            const data = errorsOnly
              ? base.filter(entry => entry.kind === 'event' && (entry.ev.channel === 'error' || /error/i.test(String(entry.ev.eventName || ''))))
              : base;
            exportJson(sanitizeForExport(data), `dstu_debug_filtered_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
          }}
          style={{ fontSize: 10, color: '#e2e8f0', background: '#334155', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}
        >
          导出筛选
        </button>
      </div>

      <div ref={listRef} className="dbg-list" style={{ flex: 1, overflow: 'auto', padding: 6, fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>
        {droppedTotal > 0 && (
          <div
            style={{
              margin: '6px 8px 12px',
              padding: '6px 10px',
              borderRadius: 6,
              background: 'rgba(234,179,8,0.12)',
              border: '1px solid rgba(234,179,8,0.35)',
              color: '#eab308',
            }}
          >
            ⚠️ 已超出缓冲上限，早期事件已截断 {droppedTotal} 条。可提高缓冲或及时导出日志。
          </div>
        )}
        {viewMode === 'raw' &&
          currentTimeline.map((ev, idx) => (
            <div key={`raw-${idx}`} className="dbg-item" style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>
              <div className="dbg-meta" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ color: '#38bdf8' }}>[{new Date(ev.ts).toLocaleTimeString()}]</span>
                <span style={{ color: '#a78bfa' }}>{ev.channel}</span>
                <span style={{ color: '#f472b6' }}>{ev.eventName}</span>
                {ev.phase && <span style={{ color: '#94a3b8' }}>phase={ev.phase}</span>}
                {ev.targetMessageId && <span style={{ color: '#94a3b8' }}>target={ev.targetMessageId}</span>}
              </div>
              <pre className="dbg-pre" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{safeStringify(ev.payload)}</pre>
            </div>
          ))}
        {viewMode === 'event' &&
          currentTimeline.map((entry, idx) => {
            if (entry.kind === 'state') {
              const key = entry.key;
              const isOpen = expandedKeys.has(key);
              const toggle = () => {
                setExpandedKeys(prev => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              };
              return (
                <div key={`state-${key}`} className="dbg-item" style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>
                  <div className="dbg-meta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: '#38bdf8' }}>[{new Date(entry.ts).toLocaleTimeString()}]</span>
                    <span className="dbg-tag dbg-tag--state" style={{ color: '#10b981' }}>[状态点]</span>
                    <span style={{ color: '#94a3b8' }}>变更: {entry.diff.length}</span>
                    <button onClick={toggle} style={{ marginLeft: 'auto', fontSize: 12, color: '#e2e8f0', background: '#334155', border: '1px solid #334155', borderRadius: 6, padding: '2px 6px' }}>{isOpen ? '收起' : '展开'}</button>
                    <button
                      onClick={() => {
                        try {
                          copyTextToClipboard(JSON.stringify(entry.data, null, 2));
                        } catch {}
                      }}
                      style={{ fontSize: 12, color: '#94a3b8', background: 'transparent', border: '1px solid #334155', borderRadius: 6, padding: '2px 6px' }}
                    >
                      复制快照
                    </button>
                  </div>
                  {isOpen && (
                    <div className="dbg-diff" style={{ marginTop: 6 }}>
                      {renderStateDiff(entry.diff)}
                      {entry.diff.length > 200 && <div style={{ color: '#94a3b8' }}>…更多变更已省略</div>}
                    </div>
                  )}
                </div>
              );
            }
            const ev = entry.ev;
            const key = `event-${ev.ts}-${idx}`;
            const isOpen = expandedKeys.has(key);
            const toggle = () => {
              setExpandedKeys(prev => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            };
            return (
              <div key={key} className="dbg-item" style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>
                <div className="dbg-meta" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ color: '#38bdf8' }}>[{new Date(ev.ts).toLocaleTimeString()}]</span>
                  <span className="dbg-tag dbg-tag--eventKind" style={{ color: '#a78bfa' }}>[事件]</span>
                  <span style={{ color: ev.channel === 'error' ? '#ef4444' : '#a78bfa' }}>{ev.channel}</span>
                  <span style={{ color: '#f472b6' }}>{ev.eventName}</span>
                  {(ev.channel === 'content' || ev.channel === 'reasoning') && <span className="dbg-tag dbg-tag--final" style={{ color: '#10b981' }}>[最终]</span>}
                  {ev.phase && <span style={{ color: '#94a3b8' }}>phase={ev.phase}</span>}
                  {ev.targetMessageId && <span style={{ color: '#94a3b8' }}>target={ev.targetMessageId}</span>}
                  <button onClick={toggle} style={{ marginLeft: 'auto', fontSize: 12, color: '#e2e8f0', background: '#334155', border: '1px solid #334155', borderRadius: 6, padding: '2px 6px' }}>{isOpen ? '收起' : '展开'}</button>
                  <button
                    onClick={() => {
                      try {
                        copyTextToClipboard(JSON.stringify(ev, null, 2));
                      } catch {}
                    }}
                    style={{ fontSize: 12, color: '#94a3b8', background: 'transparent', border: '1px solid #334155', borderRadius: 6, padding: '2px 6px' }}
                  >
                    复制事件
                  </button>
                </div>
                {isOpen && (
                  <pre className="dbg-pre" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{renderPayload('event', ev)}</pre>
                )}
              </div>
            );
          })}
        {currentTimeline.length === 0 && <div style={{ color: '#94a3b8', padding: 12 }}>暂无事件。开始一次对话/追问以查看流式原始数据。</div>}
      </div>
    </div>
  );
};

export default StreamingDebuggerPlugin;
