export type AnkiDebugLevel = 'info' | 'warn' | 'error';

export interface AnkiDebugEntry {
  id: string;
  ts: number;
  level: AnkiDebugLevel;
  event: string;
  message?: string;
  data?: unknown;
}

const BUFFER_LIMIT = 1000;

const buffer: AnkiDebugEntry[] = [];
const listeners = new Set<(entry: AnkiDebugEntry) => void>();

const generateId = () => {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}-${random}`;
};

const sanitizePayload = (payload: unknown) => {
  try {
    if (payload == null) return payload;
    if (typeof payload === 'string') {
      return payload.length > 2000 ? `${payload.slice(0, 2000)}...` : payload;
    }
    if (typeof payload === 'object') {
      return JSON.parse(JSON.stringify(payload));
    }
    return payload;
  } catch {
    return payload;
  }
};

// P0修复：禁用所有 Anki 调试日志以避免性能问题
export const publishAnkiDebugLog = (_entry: {
  level?: AnkiDebugLevel;
  event: string;
  message?: string;
  data?: unknown;
}) => {
  // 完全禁用，不做任何操作
};

export const subscribeAnkiDebugLog = (
  listener: (entry: AnkiDebugEntry) => void,
) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getAnkiDebugSnapshot = () => buffer.slice();

export const clearAnkiDebugLogs = () => {
  buffer.length = 0;
};

