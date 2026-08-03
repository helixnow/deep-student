import { invoke } from '@tauri-apps/api/core';

export type OpenAICodexLoginFlow = 'browser' | 'device_code';

// Authentication changes use the existing configuration event so every model consumer refreshes once.
export const OPENAI_CODEX_AUTH_CHANGED_EVENT = 'api_configurations_changed';

export type OpenAICodexAuthErrorClass =
  | 'cancelled'
  | 'transient'
  | 'permanent'
  | 'reauthentication_required'
  | 'security';

export interface OpenAICodexSafeAuthError {
  code?: string;
  class?: OpenAICodexAuthErrorClass;
}

export type OpenAICodexAuthState =
  | 'signed_out'
  | 'pending_browser'
  | 'pending_device_code'
  | 'signed_in'
  | 'reauth_required';

export interface OpenAICodexAuthStatus {
  state: OpenAICodexAuthState;
  hasUsableSession?: boolean;
  loginId?: string;
  generation?: number;
  email?: string;
  accountHint?: string;
  planType?: string;
  accountId?: string;
  expiresAt?: string | number;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  pollIntervalSeconds?: number;
  /** Only stable identifiers are retained. Backend error messages are discarded. */
  error?: OpenAICodexSafeAuthError;
}

export interface OpenAICodexAuthChangedDetail {
  source: 'openai_codex_auth';
  status: OpenAICodexAuthStatus;
}

export interface OpenAICodexLoginStart {
  loginId: string;
  flow: OpenAICodexLoginFlow;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string | number;
  pollIntervalSeconds?: number;
}

export interface OpenAICodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: string | number;
}

export interface OpenAICodexRateLimits {
  primary?: OpenAICodexRateLimitWindow;
  secondary?: OpenAICodexRateLimitWindow;
  limitId?: string;
  limitName?: string;
  planType?: string;
}

export interface OpenAICodexUsage {
  rateLimits?: OpenAICodexRateLimits;
  rateLimitsByLimitId?: Record<string, OpenAICodexRateLimits>;
  fetchedAt?: string | number;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const readString = (record: UnknownRecord, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const readNumber = (record: UnknownRecord, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const readBoolean = (record: UnknownRecord, ...keys: string[]): boolean | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
};

const readTimestamp = (record: UnknownRecord, ...keys: string[]): string | number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const readSafeIdentifier = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized) ? normalized : undefined;
};

const normalizeErrorClass = (value: unknown): OpenAICodexAuthErrorClass | undefined => {
  switch (readSafeIdentifier(value)) {
    case 'cancelled':
    case 'transient':
    case 'permanent':
    case 'reauthentication_required':
    case 'security':
      return readSafeIdentifier(value) as OpenAICodexAuthErrorClass;
    default:
      return undefined;
  }
};

const normalizeSafeAuthError = (
  record: UnknownRecord,
  phase: string | undefined,
): OpenAICodexSafeAuthError | undefined => {
  const rawError = record.lastError ?? record.last_error ?? record.error;
  const errorRecord = asRecord(rawError);
  const wasReported = rawError != null || phase === 'error';
  if (!wasReported) return undefined;

  return {
    code: errorRecord ? readSafeIdentifier(errorRecord.code) : undefined,
    class: errorRecord ? normalizeErrorClass(errorRecord.class) : undefined,
  };
};

const normalizeAuthState = (value: unknown): OpenAICodexAuthState => {
  switch (value) {
    case 'pending_browser':
    case 'pending_device_code':
    case 'signed_in':
    case 'reauth_required':
      return value;
    case 'signed_out':
    default:
      return 'signed_out';
  }
};

const normalizeAuthPhase = (phase: unknown, activeLoginKind: string | undefined): OpenAICodexAuthState => {
  switch (phase) {
    case 'authorizing':
      return activeLoginKind === 'device' || activeLoginKind === 'device_code'
        ? 'pending_device_code'
        : 'pending_browser';
    case 'authenticated':
    case 'refreshing':
      return 'signed_in';
    case 'reauthentication_required':
    case 'error':
      return 'reauth_required';
    case 'signed_out':
    default:
      return 'signed_out';
  }
};

const normalizeStatus = (value: unknown): OpenAICodexAuthStatus => {
  const record = asRecord(value) ?? {};
  const activeLoginKind = readString(record, 'activeLoginKind', 'active_login_kind');
  const hasLegacyState = typeof record.state === 'string';
  const phase = readString(record, 'phase');
  return {
    state: hasLegacyState
      ? normalizeAuthState(record.state)
      : normalizeAuthPhase(phase, activeLoginKind),
    hasUsableSession: readBoolean(record, 'hasUsableSession', 'has_usable_session'),
    loginId: readString(record, 'loginId', 'login_id', 'activeAttemptId', 'active_attempt_id'),
    generation: readNumber(record, 'generation'),
    email: readString(record, 'email'),
    accountHint: readString(record, 'accountHint', 'account_hint'),
    planType: readString(record, 'planType', 'plan_type'),
    accountId: readString(record, 'accountId', 'account_id'),
    expiresAt: readTimestamp(record, 'expiresAt', 'expires_at', 'expiresAtUnixMs', 'expires_at_unix_ms'),
    authUrl: readString(record, 'authUrl', 'auth_url', 'authorizationUrl', 'authorization_url'),
    verificationUrl: readString(record, 'verificationUrl', 'verification_url'),
    userCode: readString(record, 'userCode', 'user_code', 'usercode'),
    pollIntervalSeconds: readNumber(record, 'pollIntervalSeconds', 'poll_interval_seconds'),
    error: normalizeSafeAuthError(record, phase),
  };
};

const normalizeLoginStart = (value: unknown, flow: OpenAICodexLoginFlow): OpenAICodexLoginStart => {
  const record = asRecord(value) ?? {};
  const returnedFlow = readString(record, 'flow');
  return {
    loginId: readString(record, 'loginId', 'login_id', 'attemptId', 'attempt_id') ?? '',
    flow: returnedFlow === 'device_code' || returnedFlow === 'device' ? 'device_code' : flow,
    authUrl: readString(record, 'authUrl', 'auth_url', 'authorizationUrl', 'authorization_url'),
    verificationUrl: readString(record, 'verificationUrl', 'verification_url'),
    userCode: readString(record, 'userCode', 'user_code'),
    expiresAt: readTimestamp(record, 'expiresAt', 'expires_at', 'expiresAtUnixMs', 'expires_at_unix_ms'),
    pollIntervalSeconds: readNumber(record, 'pollIntervalSeconds', 'poll_interval_seconds'),
  };
};

const normalizeRateLimitWindow = (value: unknown): OpenAICodexRateLimitWindow | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;

  let usedPercent = readNumber(record, 'usedPercent', 'used_percent');
  const remainingPercent = readNumber(record, 'remainingPercent', 'remaining_percent');
  if (usedPercent == null && remainingPercent != null) {
    usedPercent = 100 - remainingPercent;
  }

  const normalized = {
    usedPercent: usedPercent == null ? undefined : Math.max(0, Math.min(100, usedPercent)),
    windowDurationMins: readNumber(
      record,
      'windowDurationMins',
      'window_duration_mins',
      'windowMinutes',
      'window_minutes',
    ),
    resetsAt: readTimestamp(record, 'resetsAt', 'resets_at'),
  };

  return Object.values(normalized).some(item => item != null) ? normalized : undefined;
};

const normalizeRateLimits = (value: unknown): OpenAICodexRateLimits | undefined => {
  const outer = asRecord(value);
  if (!outer) return undefined;
  const record = asRecord(outer.rateLimits) ?? asRecord(outer.rate_limits) ?? outer;
  const normalized: OpenAICodexRateLimits = {
    primary: normalizeRateLimitWindow(record.primary),
    secondary: normalizeRateLimitWindow(record.secondary),
    limitId: readString(outer, 'limitId', 'limit_id') ?? readString(record, 'limitId', 'limit_id'),
    limitName: readString(outer, 'limitName', 'limit_name') ?? readString(record, 'limitName', 'limit_name'),
    planType: readString(outer, 'planType', 'plan_type') ?? readString(record, 'planType', 'plan_type'),
  };
  return Object.values(normalized).some(item => item != null) ? normalized : undefined;
};

const normalizeUsage = (value: unknown): OpenAICodexUsage => {
  const outer = asRecord(value) ?? {};
  const record = asRecord(outer.usage) ?? outer;
  const byLimitIdRaw = asRecord(record.rateLimitsByLimitId) ?? asRecord(record.rate_limits_by_limit_id);
  const rateLimitsByLimitId = byLimitIdRaw
    ? Object.fromEntries(
        Object.entries(byLimitIdRaw)
          .map(([limitId, entry]) => [limitId, normalizeRateLimits(entry)] as const)
          .filter((entry): entry is readonly [string, OpenAICodexRateLimits] => Boolean(entry[1])),
      )
    : undefined;

  return {
    rateLimits: normalizeRateLimits(record.rateLimits ?? record.rate_limits),
    rateLimitsByLimitId: rateLimitsByLimitId && Object.keys(rateLimitsByLimitId).length > 0
      ? rateLimitsByLimitId
      : undefined,
    fetchedAt: readTimestamp(record, 'fetchedAt', 'fetched_at'),
  };
};

class OpenAICodexAuthClientError extends Error {
  constructor(command: string) {
    super(`OpenAI Codex auth command failed: ${command}`);
    this.name = 'OpenAICodexAuthClientError';
  }
}

const call = async <T>(command: string, args?: UnknownRecord): Promise<T> => {
  try {
    return await invoke<T>(command, args);
  } catch {
    // Backend errors can contain request context. Never forward them into UI state.
    throw new OpenAICodexAuthClientError(command);
  }
};

const STATUS_MONITOR_DEFAULT_INTERVAL_MS = 1_500;
const STATUS_MONITOR_MIN_INTERVAL_MS = 1_000;

let lastObservedStatusFingerprint: string | null = null;
let lastObservedStatus: OpenAICodexAuthStatus | null = null;
let statusObservationSequence = 0;
let latestCommittedStatusObservation = 0;
let statusMonitorTimer: ReturnType<typeof setTimeout> | null = null;
let statusMonitorGeneration = 0;
let statusMonitorActive = false;

const statusIdentity = (status: OpenAICodexAuthStatus): string => (
  status.accountId ?? status.accountHint ?? status.email ?? ''
);

const statusFingerprint = (status: OpenAICodexAuthStatus): string => JSON.stringify([
  status.state,
  status.hasUsableSession ?? '',
  statusIdentity(status),
  status.loginId ?? '',
  status.generation ?? '',
  status.error?.code ?? '',
  status.error?.class ?? '',
]);

const dispatchAuthChanged = (status: OpenAICodexAuthStatus) => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent<OpenAICodexAuthChangedDetail>(OPENAI_CODEX_AUTH_CHANGED_EVENT, {
    detail: { source: 'openai_codex_auth', status },
  }));
};

const observeStatus = (status: OpenAICodexAuthStatus, forceBroadcast = false) => {
  const fingerprint = statusFingerprint(status);
  const changed = lastObservedStatusFingerprint !== null && lastObservedStatusFingerprint !== fingerprint;
  lastObservedStatusFingerprint = fingerprint;
  if (changed || forceBroadcast) dispatchAuthChanged(status);
};

const commitStatusObservation = (
  status: OpenAICodexAuthStatus,
  observation: number,
  forceBroadcast = false,
): OpenAICodexAuthStatus => {
  if (observation < latestCommittedStatusObservation && lastObservedStatus) {
    return lastObservedStatus;
  }
  latestCommittedStatusObservation = observation;
  lastObservedStatus = status;
  observeStatus(status, forceBroadcast);
  return status;
};

const invalidatePendingStatusObservations = () => {
  latestCommittedStatusObservation = ++statusObservationSequence;
};

const isPendingStatus = (status: OpenAICodexAuthStatus): boolean => (
  status.state === 'pending_browser' || status.state === 'pending_device_code'
);

const monitorIntervalMs = (pollIntervalSeconds?: number): number => Math.max(
  STATUS_MONITOR_MIN_INTERVAL_MS,
  (pollIntervalSeconds ?? STATUS_MONITOR_DEFAULT_INTERVAL_MS / 1_000) * 1_000,
);

const stopStatusMonitor = () => {
  statusMonitorActive = false;
  statusMonitorGeneration += 1;
  if (statusMonitorTimer !== null) {
    clearTimeout(statusMonitorTimer);
    statusMonitorTimer = null;
  }
};

const readAndObserveStatus = async (): Promise<OpenAICodexAuthStatus> => {
  const observation = ++statusObservationSequence;
  const status = normalizeStatus(await call('openai_codex_auth_status'));
  return commitStatusObservation(status, observation);
};

const scheduleStatusMonitor = (generation: number, delayMs: number) => {
  if (!statusMonitorActive || generation !== statusMonitorGeneration || statusMonitorTimer !== null) return;
  statusMonitorTimer = setTimeout(async () => {
    statusMonitorTimer = null;
    if (!statusMonitorActive || generation !== statusMonitorGeneration) return;
    try {
      const status = await readAndObserveStatus();
      if (!isPendingStatus(status)) {
        stopStatusMonitor();
        return;
      }
      scheduleStatusMonitor(generation, monitorIntervalMs(status.pollIntervalSeconds));
    } catch {
      scheduleStatusMonitor(generation, STATUS_MONITOR_DEFAULT_INTERVAL_MS);
    }
  }, delayMs);
};

const ensureStatusMonitor = (delayMs: number) => {
  if (!statusMonitorActive) {
    statusMonitorActive = true;
    statusMonitorGeneration += 1;
  }
  scheduleStatusMonitor(statusMonitorGeneration, delayMs);
};

const reconcileStatusMonitor = (status: OpenAICodexAuthStatus) => {
  if (isPendingStatus(status)) {
    ensureStatusMonitor(monitorIntervalMs(status.pollIntervalSeconds));
  } else if (statusMonitorActive) {
    stopStatusMonitor();
  }
};

export const openaiCodexAuthClient = {
  async status(): Promise<OpenAICodexAuthStatus> {
    const status = await readAndObserveStatus();
    reconcileStatusMonitor(status);
    return status;
  },

  async loginStart(flow: OpenAICodexLoginFlow): Promise<OpenAICodexLoginStart> {
    const result = normalizeLoginStart(await call('openai_codex_login_start', { flow }), flow);
    if (!result.loginId) {
      throw new OpenAICodexAuthClientError('openai_codex_login_start');
    }
    const pendingStatus: OpenAICodexAuthStatus = {
      state: result.flow === 'device_code' ? 'pending_device_code' : 'pending_browser',
      hasUsableSession: lastObservedStatus?.hasUsableSession
        ?? (lastObservedStatus?.state === 'signed_in'),
      loginId: result.loginId,
      authUrl: result.authUrl,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
      expiresAt: result.expiresAt,
      pollIntervalSeconds: result.pollIntervalSeconds,
    };
    commitStatusObservation(pendingStatus, ++statusObservationSequence, true);
    stopStatusMonitor();
    ensureStatusMonitor(monitorIntervalMs(result.pollIntervalSeconds));
    return result;
  },

  async loginCancel(attemptId: string): Promise<void> {
    const normalizedAttemptId = attemptId.trim();
    if (!normalizedAttemptId) {
      throw new OpenAICodexAuthClientError('openai_codex_login_cancel');
    }
    await call('openai_codex_login_cancel', { attemptId: normalizedAttemptId });
    invalidatePendingStatusObservations();
    stopStatusMonitor();
    try {
      const status = await readAndObserveStatus();
      reconcileStatusMonitor(status);
    } catch {
      // The mutation succeeded; a follow-up status failure must not report cancellation as failed.
    }
  },

  async logout(): Promise<void> {
    await call('openai_codex_logout');
    invalidatePendingStatusObservations();
    stopStatusMonitor();
    try {
      const status = await readAndObserveStatus();
      reconcileStatusMonitor(status);
    } catch {
      // The mutation succeeded; a follow-up status failure must not report logout as failed.
    }
  },

  async usage(): Promise<OpenAICodexUsage> {
    return normalizeUsage(await call('openai_codex_usage'));
  },

  stopStatusMonitor(): void {
    stopStatusMonitor();
  },
};
