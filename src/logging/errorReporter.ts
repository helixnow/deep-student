import { invoke } from '@tauri-apps/api/core';

export type FrontendErrorKind =
  | 'WINDOW_ERROR'
  | 'UNHANDLED_REJECTION'
  | 'RESOURCE_LOAD_ERROR'
  | 'REACT_ERROR_BOUNDARY'
  | 'NETWORK_ERROR'
  | 'PLUGIN_ERROR'
  | 'CAUGHT_ERROR'
  | string;

export interface FrontendErrorContext {
  kind?: FrontendErrorKind;
  component?: string;
  route?: string;
  url?: string;
  line?: number;
  column?: number;
  level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  extra?: unknown;
}

interface NormalizedError {
  name: string;
  message: string;
  stack?: string;
}

const MAX_STRING_LENGTH = 16_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 4;
const DEDUPE_WINDOW_MS = 10_000;
const MAX_REPORTS_PER_MINUTE = 60;
export const FRONTEND_ERROR_REPORTED_EVENT = 'dstu:frontend-error-reported';
const recentReports = new Map<string, number>();
const recentFingerprints = new Map<string, number>();
const reportTimestamps: number[] = [];

const SECRET_VALUE = /\b(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+/=-]{8,})\b/gi;
const QUERY_SECRET = /([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi;
const TEXT_SECRET = /(?:api[-_ ]?key|x[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|cookie|password|passwd|client[-_ ]?secret|private[-_ ]?key)\s*[:=]\s*["']?[^"',\s}\]]{4,}/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_VALUE = /\b(?:https?|tauri|asset|file):\/\/[^\s"'<>]+/gi;
const WINDOWS_USER_PATH = /[A-Z]:\\Users\\[^\\]+\\/gi;
const UNIX_USER_PATH = /\/(?:Users|home)\/[^/]+\//g;
const stripUrlSecrets = (value: string): string => {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value.replace(/[?#].*$/, '');
  }
};
const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return [
    'apikey',
    'authorization',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'cookie',
    'setcookie',
    'credential',
    'credentials',
    'password',
    'passwd',
    'secret',
    'secretkey',
    'clientsecret',
    'privatekey',
  ].includes(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('token')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('cookie');
};

const truncate = (value: string): string =>
  value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`
    : value;

const redactString = (value: string): string =>
  truncate(
    value
      .replace(SECRET_VALUE, '[REDACTED]')
      .replace(QUERY_SECRET, '$1[REDACTED]')
      .replace(TEXT_SECRET, '[REDACTED]')
      .replace(PRIVATE_KEY, '[REDACTED_PRIVATE_KEY]')
      .replace(URL_VALUE, stripUrlSecrets)
      .replace(WINDOWS_USER_PATH, 'C:\\Users\\<REDACTED>\\')
      .replace(UNIX_USER_PATH, '/<REDACTED>/'),
  );

const scrubUrl = (value: string): string => redactString(value).replace(/[?#].*$/, '');
const scrubRoute = (value: string): string => redactString(value).replace(/\?.*$/, '');

export function serializeUnknown(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Error) {
    const record = value as Error & { cause?: unknown; code?: unknown };
    return {
      name: record.name,
      message: redactString(record.message || ''),
      stack: record.stack ? redactString(record.stack) : undefined,
      code: record.code == null ? undefined : String(record.code),
      cause: depth < MAX_DEPTH ? serializeUnknown(record.cause, depth + 1, seen) : undefined,
    };
  }
  if (depth >= MAX_DEPTH) return '[Max depth reached]';
  if (typeof value !== 'object') return redactString(String(value));
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => serializeUnknown(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : serializeUnknown(child, depth + 1, seen);
  }
  return output;
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: redactString(error.message || error.name || 'Unknown error'),
      stack: error.stack ? redactString(error.stack) : undefined,
    };
  }
  if (typeof error === 'string') {
    return { name: 'Error', message: redactString(error) };
  }
  if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      message:
        typeof candidate.message === 'string'
          ? redactString(candidate.message)
          : redactString(String(error)),
      stack: typeof candidate.stack === 'string' ? redactString(candidate.stack) : undefined,
    };
  }
  return { name: 'Error', message: redactString(String(error ?? 'Unknown error')) };
}

function isKnownHarmlessTauriCancellation(message: string, stack = ''): boolean {
  const combined = `${message}\n${stack}`.toLowerCase();
  const cancellationNoise =
    (combined.includes('fetch_cancel_body') || combined.includes('resource id') && combined.includes('invalid')) &&
    (combined.includes('tauri') || combined.includes('streamchannel') || combined.includes('ipc custom protocol'));
  const streamChannelNoise =
    (combined.includes('fetch_read_body') || combined.includes('fetch_send')) &&
    combined.includes('streamchannel') &&
    (combined.includes('tauri') || combined.includes('ipc custom protocol'));
  return cancellationNoise || streamChannelNoise;
}

function shouldReport(key: string, fingerprint: string, fallbackOnly: boolean): boolean {
  const now = Date.now();
  for (const [storedKey, storedAt] of recentReports) {
    if (now - storedAt > DEDUPE_WINDOW_MS) recentReports.delete(storedKey);
  }
  for (const [storedFingerprint, storedAt] of recentFingerprints) {
    if (now - storedAt > DEDUPE_WINDOW_MS) recentFingerprints.delete(storedFingerprint);
  }
  while (reportTimestamps.length > 0 && now - reportTimestamps[0] > 60_000) {
    reportTimestamps.shift();
  }
  if (fallbackOnly && recentFingerprints.has(fingerprint)) return false;
  const last = recentReports.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return false;
  if (reportTimestamps.length >= MAX_REPORTS_PER_MINUTE) return false;
  recentReports.set(key, now);
  recentFingerprints.set(fingerprint, now);
  reportTimestamps.push(now);
  return true;
}

export async function reportFrontendError(
  error: unknown,
  context: FrontendErrorContext = {},
): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  const normalized = normalizeError(error);
  if (isKnownHarmlessTauriCancellation(normalized.message, normalized.stack)) return;

  const kind = context.kind ?? 'CAUGHT_ERROR';
  const fingerprint = `${normalized.message}\n${normalized.stack ?? ''}`;
  const dedupeKey = `${kind}\n${fingerprint}`;
  if (!shouldReport(dedupeKey, fingerprint, kind === 'CONSOLE_ERROR')) return;

  const payload = {
    level: context.level ?? 'ERROR',
    kind,
    message: `${normalized.name}: ${normalized.message}`,
    stack: normalized.stack ?? null,
    component: context.component ?? null,
    route: scrubRoute(context.route ?? (window.location.hash || window.location.pathname)),
    url: scrubUrl(context.url ?? window.location.href),
    line: context.line ?? null,
    column: context.column ?? null,
    user_agent: navigator.userAgent,
    extra: serializeUnknown(context.extra ?? error),
  };

  window.dispatchEvent(new CustomEvent(FRONTEND_ERROR_REPORTED_EVENT, { detail: payload }));
  await invoke('report_frontend_log', { payload });
}

type ReporterWindow = Window & {
  __DSTU_ERROR_REPORTER_CLEANUP__?: () => void;
  __DSTU_BOOT_DIAGNOSTICS_CLEANUP__?: () => void;
};

export function installGlobalErrorReporter(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const globalWindow = window as ReporterWindow;
  globalWindow.__DSTU_ERROR_REPORTER_CLEANUP__?.();
  globalWindow.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__?.();

  const handleError = (event: ErrorEvent) => {
    const eventTarget = event.target;
    const target =
      eventTarget instanceof HTMLElement
        ? (eventTarget as HTMLElement & { src?: string; href?: string })
        : null;
    if (target && eventTarget !== window && !event.message) {
      const resource = target.src || target.href || target.tagName || 'unknown resource';
      void reportFrontendError(`Failed to load resource: ${resource}`, {
        kind: 'RESOURCE_LOAD_ERROR',
        url: resource,
        extra: { tagName: target.tagName },
      }).catch(() => undefined);
      return;
    }
    if (!event.message && !event.error) return;
    void reportFrontendError(event.error ?? event.message, {
      kind: 'WINDOW_ERROR',
      url: event.filename || window.location.href,
      line: event.lineno || undefined,
      column: event.colno || undefined,
    }).catch(() => undefined);
  };

  const handleRejection = (event: PromiseRejectionEvent) => {
    const normalized = normalizeError(event.reason);
    if (isKnownHarmlessTauriCancellation(normalized.message, normalized.stack)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    void reportFrontendError(event.reason, {
      kind: 'UNHANDLED_REJECTION',
    }).catch(() => undefined);
  };

  window.addEventListener('error', handleError, true);
  window.addEventListener('unhandledrejection', handleRejection, true);
  const blankScreenTimer = window.setTimeout(() => {
    const root = document.getElementById('root');
    if (!root || root.childElementCount === 0) {
      void reportFrontendError('Application root is empty after startup timeout', {
        kind: 'BLANK_SCREEN',
        component: 'root',
      }).catch(() => undefined);
    }
  }, 8_000);
  const originalConsoleError = console.error;
  let wrappedConsoleError: typeof console.error | null = null;
  if (import.meta.env.PROD) {
    wrappedConsoleError = (...args: unknown[]) => {
      originalConsoleError.apply(console, args as any);
      if (
        typeof args[0] === 'string'
        && (args[0].startsWith('🚨 [') || args[0].includes('[debugLogger]'))
      ) {
        return;
      }
      const candidate = args.find(arg => arg instanceof Error) ?? (() => {
        const error = new Error(String(args[0] ?? 'console.error'));
        error.name = 'ConsoleError';
        return error;
      })();
      queueMicrotask(() => {
        void reportFrontendError(candidate, {
          kind: 'CONSOLE_ERROR',
          extra: { arguments: args.slice(0, 5) },
        }).catch(() => undefined);
      });
    };
    console.error = wrappedConsoleError;
  }

  const cleanup = () => {
    window.removeEventListener('error', handleError, true);
    window.removeEventListener('unhandledrejection', handleRejection, true);
    window.clearTimeout(blankScreenTimer);
    if (wrappedConsoleError && console.error === wrappedConsoleError) {
      console.error = originalConsoleError;
    }
    if (globalWindow.__DSTU_ERROR_REPORTER_CLEANUP__ === cleanup) {
      delete globalWindow.__DSTU_ERROR_REPORTER_CLEANUP__;
    }
  };
  globalWindow.__DSTU_ERROR_REPORTER_CLEANUP__ = cleanup;
  return cleanup;
}
