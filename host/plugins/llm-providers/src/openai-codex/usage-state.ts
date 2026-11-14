import type { CodexRateLimitWindow, CodexRateLimits, CodexUsageSnapshot } from '../../api.ts';

/** Rust DTO fields stay u64/i64 inside the Host; generated DTOs describe IPC numbers. */
export type CodexRateLimitWindowState = Omit<CodexRateLimitWindow, 'windowDurationMins' | 'resetsAt'> & {
  windowDurationMins?: bigint | null;
  resetsAt?: bigint | null;
};
export type CodexRateLimitsState = Omit<CodexRateLimits, 'primary' | 'secondary'> & {
  primary?: CodexRateLimitWindowState | null;
  secondary?: CodexRateLimitWindowState | null;
};
export type CodexUsageState = Omit<CodexUsageSnapshot, 'rateLimits' | 'rateLimitsByLimitId' | 'fetchedAt'> & {
  rateLimits?: CodexRateLimitsState | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitsState>;
  fetchedAt: bigint;
};
