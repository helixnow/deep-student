import type { StreamingSmoothingPreset } from './streamingSmoothing';

export type StreamingMarkdownProfilerEventType =
  | 'target'
  | 'display'
  | 'flush'
  | 'reset';

export interface StreamingMarkdownProfilerEvent {
  id: number;
  timestamp: number;
  type: StreamingMarkdownProfilerEventType;
  preset?: StreamingSmoothingPreset;
  targetLength?: number;
  displayedLength?: number;
  delta?: number;
  remaining?: number;
  reason?: string;
  blockId?: string;
  messageId?: string;
}

export type StreamingMarkdownProfilerEventInput =
  Omit<StreamingMarkdownProfilerEvent, 'id' | 'timestamp'>;

export interface StreamingMarkdownProfilerSnapshot {
  label: string;
  enabled: boolean;
  droppedEvents: number;
  events: StreamingMarkdownProfilerEvent[];
}

export interface StreamingMarkdownProfiler {
  record: (event: StreamingMarkdownProfilerEventInput) => void;
  reset: (reason?: string) => void;
  getSnapshot: () => StreamingMarkdownProfilerSnapshot;
  subscribe: (listener: (snapshot: StreamingMarkdownProfilerSnapshot) => void) => () => void;
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
}

export interface CreateStreamingMarkdownProfilerOptions {
  label: string;
  enabled?: boolean;
  maxEvents?: number;
}

const now = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

export function createStreamingMarkdownProfiler({
  label,
  enabled = false,
  maxEvents = 500,
}: CreateStreamingMarkdownProfilerOptions): StreamingMarkdownProfiler {
  let events: StreamingMarkdownProfilerEvent[] = [];
  let droppedEvents = 0;
  let nextId = 1;
  let active = enabled;
  const listeners = new Set<(snapshot: StreamingMarkdownProfilerSnapshot) => void>();

  const getSnapshot = (): StreamingMarkdownProfilerSnapshot => ({
    label,
    enabled: active,
    droppedEvents,
    events: [...events],
  });

  const notify = () => {
    const snapshot = getSnapshot();
    listeners.forEach((listener) => listener(snapshot));
  };

  const record = (event: StreamingMarkdownProfilerEventInput) => {
    if (!active) return;
    events.push({
      ...event,
      id: nextId,
      timestamp: now(),
    });
    nextId += 1;

    while (events.length > maxEvents) {
      events.shift();
      droppedEvents += 1;
    }

    notify();
  };

  const reset = (reason = 'manual') => {
    events = [];
    droppedEvents = 0;
    nextId = 1;
    if (active) {
      record({ type: 'reset', reason });
    } else {
      notify();
    }
  };

  return {
    record,
    reset,
    getSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEnabled: (nextEnabled) => {
      active = nextEnabled;
      notify();
    },
    isEnabled: () => active,
  };
}

export const streamingMarkdownProfiler = createStreamingMarkdownProfiler({
  label: 'deep-student-markdown-stream',
  maxEvents: 1000,
});

declare global {
  interface Window {
    __DEEP_STUDENT_STREAMING_PROFILER__?: StreamingMarkdownProfiler;
  }
}

if (typeof window !== 'undefined') {
  window.__DEEP_STUDENT_STREAMING_PROFILER__ = streamingMarkdownProfiler;
}
