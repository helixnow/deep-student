import type { CodexRateLimitWindow, CodexRateLimits, CodexUsageSnapshot } from '../../api.ts';
import type { CodexRateLimitWindowState, CodexRateLimitsState, CodexUsageState } from './usage-state.ts';

function windowToWire(window: CodexRateLimitWindowState): CodexRateLimitWindow {
  const { windowDurationMins, resetsAt, ...rest } = window;
  const wire: CodexRateLimitWindow = { ...rest };
  if (windowDurationMins !== undefined) wire.windowDurationMins = windowDurationMins === null ? null : Number(windowDurationMins);
  if (resetsAt !== undefined) wire.resetsAt = resetsAt === null ? null : Number(resetsAt);
  // serde_json1.0.149 ser.rs:169-178 serializes f64 NaN/Infinity as null.
  // Some(NaN) is present, unlike Option::None with skip_serializing_if.
  if (typeof wire.usedPercent === 'number' && !Number.isFinite(wire.usedPercent)) wire.usedPercent = null;
  return wire;
}

function limitsToWire(limits: CodexRateLimitsState): CodexRateLimits {
  const { primary, secondary, ...rest } = limits;
  const wire: CodexRateLimits = { ...rest };
  if (primary !== undefined) wire.primary = primary === null ? null : windowToWire(primary);
  if (secondary !== undefined) wire.secondary = secondary === null ? null : windowToWire(secondary);
  return wire;
}

/** Only the openai_codex_usage IPC handler narrows Host integers/encodes non-finite floats. */
export function codexUsageToWire(snapshot: CodexUsageState): CodexUsageSnapshot {
  const { rateLimits, rateLimitsByLimitId, fetchedAt, ...rest } = snapshot;
  const wire: CodexUsageSnapshot = { ...rest, fetchedAt: Number(fetchedAt) };
  if (rateLimits !== undefined) wire.rateLimits = rateLimits === null ? null : limitsToWire(rateLimits);
  if (rateLimitsByLimitId !== undefined) {
    wire.rateLimitsByLimitId = Object.fromEntries(
      Object.entries(rateLimitsByLimitId).map(([id, limits]) => [id, limitsToWire(limits)]),
    );
  }
  return wire;
}
