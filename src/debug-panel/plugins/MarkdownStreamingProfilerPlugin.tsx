import React from 'react';
import { streamingMarkdownProfiler, type StreamingMarkdownProfilerSnapshot } from '@/features/chat/components/renderers/streamingProfiler';

export interface MarkdownStreamingProfilerPluginProps {
  visible: boolean;
  isActive: boolean;
  isActivated: boolean;
  onClose: () => void;
}

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  flexDirection: 'column',
  overflow: 'hidden',
  background: '#0f172a',
  color: '#dbeafe',
};

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  padding: '8px 12px',
  borderBottom: '1px solid #1e293b',
  flexWrap: 'wrap',
};

const buttonStyle: React.CSSProperties = {
  border: '1px solid #334155',
  borderRadius: 6,
  background: '#1e293b',
  color: '#e2e8f0',
  cursor: 'pointer',
  fontSize: 12,
  padding: '4px 8px',
};

const metricStyle: React.CSSProperties = {
  display: 'inline-flex',
  gap: 4,
  alignItems: 'baseline',
  border: '1px solid #1e293b',
  borderRadius: 8,
  background: '#111827',
  padding: '6px 8px',
  fontSize: 12,
};

const eventRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '56px 72px 72px minmax(0, 1fr)',
  gap: 8,
  alignItems: 'center',
  borderBottom: '1px solid rgba(51, 65, 85, 0.45)',
  padding: '5px 8px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 11,
};

const eventColor: Record<string, string> = {
  target: '#fbbf24',
  display: '#34d399',
  flush: '#60a5fa',
  reset: '#f87171',
};

const MarkdownStreamingProfilerPlugin: React.FC<MarkdownStreamingProfilerPluginProps> = ({
  isActivated,
}) => {
  const [snapshot, setSnapshot] = React.useState<StreamingMarkdownProfilerSnapshot>(() =>
    streamingMarkdownProfiler.getSnapshot()
  );

  React.useEffect(() => {
    if (!isActivated) return undefined;
    streamingMarkdownProfiler.setEnabled(true);
    setSnapshot(streamingMarkdownProfiler.getSnapshot());
    return streamingMarkdownProfiler.subscribe(setSnapshot);
  }, [isActivated]);

  const latestTarget = React.useMemo(
    () => [...snapshot.events].reverse().find((event) => event.type === 'target'),
    [snapshot.events]
  );
  const latestDisplay = React.useMemo(
    () => [...snapshot.events].reverse().find((event) => event.type === 'display' || event.type === 'flush'),
    [snapshot.events]
  );
  const lag = Math.max(
    0,
    (latestTarget?.targetLength ?? 0) - (latestDisplay?.displayedLength ?? 0)
  );

  const visibleEvents = snapshot.events.slice(-160).reverse();

  return (
    <div style={panelStyle}>
      <div style={toolbarStyle}>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => streamingMarkdownProfiler.reset('debug-panel')}
        >
          Reset
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            const next = !streamingMarkdownProfiler.isEnabled();
            streamingMarkdownProfiler.setEnabled(next);
            setSnapshot(streamingMarkdownProfiler.getSnapshot());
          }}
        >
          {snapshot.enabled ? 'Pause profiler' : 'Resume profiler'}
        </button>
        <span style={metricStyle}>
          <span style={{ color: '#94a3b8' }}>events</span>
          <strong>{snapshot.events.length}</strong>
        </span>
        <span style={metricStyle}>
          <span style={{ color: '#94a3b8' }}>dropped</span>
          <strong>{snapshot.droppedEvents}</strong>
        </span>
        <span style={metricStyle}>
          <span style={{ color: '#94a3b8' }}>lag</span>
          <strong>{lag}</strong>
          <span style={{ color: '#64748b' }}>chars</span>
        </span>
        <span style={metricStyle}>
          <span style={{ color: '#94a3b8' }}>preset</span>
          <strong>{latestDisplay?.preset ?? latestTarget?.preset ?? '-'}</strong>
        </span>
      </div>

      <div style={{ padding: '8px 12px', color: '#93c5fd', fontSize: 12, borderBottom: '1px solid #1e293b' }}>
        Console: <code>window.__DEEP_STUDENT_STREAMING_PROFILER__.getSnapshot()</code>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {visibleEvents.length === 0 ? (
          <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>
            Start a streaming answer to collect Markdown smoothing events.
          </div>
        ) : (
          visibleEvents.map((event) => (
            <div key={event.id} style={eventRowStyle}>
              <span style={{ color: eventColor[event.type] ?? '#cbd5e1' }}>{event.type}</span>
              <span style={{ color: '#93c5fd' }}>{event.preset ?? '-'}</span>
              <span style={{ color: '#c4b5fd' }}>
                {typeof event.delta === 'number' ? `+${event.delta}` : '-'}
              </span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                target={event.targetLength ?? '-'} display={event.displayedLength ?? '-'} remaining={event.remaining ?? '-'} reason={event.reason ?? '-'}
                {event.blockId ? ` block=${event.blockId}` : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default MarkdownStreamingProfilerPlugin;
