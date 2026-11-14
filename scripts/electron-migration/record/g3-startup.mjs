// G3-STARTUP: where a take starts being observed, the same on the A (Tauri) and B (Host)
// recorders. From the app's ready point both wait until startup background work has run —
// Rust plugin bootstrap 3 s after setup (lib.rs:1362-1366), Lance maintenance 6 s after setup
// (lib.rs:1645-1656) and its Host twin (vfs-index startup-maintenance.ts, 6 s after the
// storage finalizer) — and the databases and event count have then been still for a window;
// the recorder's own setup command runs and settles; then the boundary is taken.
// Events before the boundary are kept as `trace.startup.events`, never compared: the A
// webview hears nothing a Tauri setup hook emits before its first listen (Tauri does not
// buffer), B's fork hears everything, so comparing them would compare the recorders. The
// `before` capture and every capture list start at the boundary on both sides.
import { QUIET, quiesce } from './g3-quiet.mjs';

export const STARTUP_RULE = 'G3-STARTUP/v1';
export const STARTUP = { settleMs: 8_000, windowMs: 1_000, maxMs: 30_000, pollMs: 50 };
// Pins the 5 s VFS index worker to the 24 h maximum on both sides so its timer cannot
// interleave with command captures (the worker stays enabled). Not every boot registers it
// (recovery mode returns before the vfs commands exist), so its outcome is recorded, not required.
export const SETUP = { command: 'vfs_set_indexing_config', argsRaw: '{"key":"indexing.interval_secs","value":"86400"}' };

const sleeping = ms => new Promise(resolve => setTimeout(resolve, ms));

/** At least `settleMs` after ready, then still for `windowMs`; bounded at `maxMs` after ready (unsettled is recorded, not an error). */
export async function settleStartup({ events, fingerprint, readyAt, now = Date.now, sleep = sleeping, limits = STARTUP }) {
  const start = now();
  while (now() < readyAt + limits.settleMs) await sleep(Math.min(limits.pollMs * 10, readyAt + limits.settleMs - now()));
  const signature = () => `${events().length}\u0000${fingerprint()}`;
  let last = signature(), stableSince = now();
  while (now() - stableSince < limits.windowMs) {
    if (now() - readyAt >= limits.maxMs) return { waitedMs: now() - start, sinceReadyMs: now() - readyAt, settled: false };
    await sleep(limits.pollMs);
    const current = signature();
    if (current !== last) { last = current; stableSince = now(); }
  }
  return { waitedMs: now() - start, sinceReadyMs: now() - readyAt, settled: true };
}

/**
 * Both recorders call this once, right after ready, with their own event list (A: subscribed
 * at ready; B: everything since fork), database fingerprint and invoke ({kind, raw}).
 * Returns the boundary (index into events()) and the record for `trace.startup`.
 */
export async function runStartup({ events, fingerprint, invoke, readyAt, now = Date.now, sleep = sleeping, limits = STARTUP, quiet = QUIET }) {
  const settle = await settleStartup({ events, fingerprint, readyAt, now, sleep, limits });
  const outcome = await invoke(SETUP.command, SETUP.argsRaw);
  if (!['result', 'error'].includes(outcome?.kind) || typeof outcome.raw !== 'string') throw new Error('startup setup: missing raw IPC outcome');
  const setupQuiet = await quiesce({ events, fingerprint, now, sleep, limits: quiet });
  const boundary = events().length;
  return { boundary, record: { rule: STARTUP_RULE, settle, setup: { command: SETUP.command, argsRaw: SETUP.argsRaw, outcome }, quiet: setupQuiet,
    boundaryMs: now() - readyAt, events: events().slice(0, boundary) } };
}

/** Same protocol on every take of a compare, or the compare is refused (an old A store against a new B). */
export function startupProtocol(trace) {
  return trace?.startup?.rule ?? null;
}
