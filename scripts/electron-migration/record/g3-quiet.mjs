// N-013 capture timing, shared by the A (Tauri) and B (Host) recorders: before every capture,
// wait for session streams that already started to reach a terminal event, then for the event
// count and the SQLite files to stop changing for a short window. Both waits are bounded; an
// unsettled capture is recorded in `quiet`, never turned into an error or a different result.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const QUIET_RULE = 'N-013';
export const QUIET = { windowMs: 300, maxMs: 3_000, streamMs: 5_000, pollMs: 25 };
const STREAM_CHANNEL = 'chat_v2_session_';
const TERMINAL = new Set(['stream_complete', 'stream_error', 'stream_cancelled']);
// A scenario that waits for these wants the state in the middle of a stream.
const MID_STREAM = /^(stream_start|[a-z_]+:(start|chunk))$/;
const DATABASE_FILE = /\.(db|db3|sqlite|sqlite3)(-wal|-journal)?$/i;

/** `<channel>#<messageId>` of session streams with a stream_start and no terminal event yet. */
export function openStreams(events) {
  const open = new Set();
  for (const event of events) {
    if (!event.event.startsWith(STREAM_CHANNEL)) continue;
    let payload;
    try { payload = JSON.parse(event.payloadRaw); } catch { continue; }
    const key = `${event.event}#${payload?.messageId ?? ''}`;
    if (payload?.eventType === 'stream_start') open.add(key);
    else if (TERMINAL.has(payload?.eventType)) open.delete(key);
  }
  return [...open].sort();
}

const midStream = spec => typeof spec?.event === 'string' && spec.event.split('|').some(name => MID_STREAM.test(name));

/** Size and mtime of every SQLite main/WAL/journal file under `directory` (-shm changes on reads). */
export function databaseFingerprint(directory) {
  const parts = [];
  const walk = current => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && DATABASE_FILE.test(entry.name)) {
        try { const stat = statSync(full, { bigint: true }); parts.push(`${relative(directory, full)}:${stat.size}:${stat.mtimeNs}`); } catch { parts.push(`${relative(directory, full)}:gone`); }
      }
    }
  };
  walk(directory);
  return parts.sort().join('\n');
}

/**
 * `step` is the step just run (its waitAfter) and `next` the one about to run (its waitBefore);
 * either asking for a mid-stream event skips the wait, so the scenario's intent is kept.
 */
export async function quiesce({ events, fingerprint, step = null, next = null, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), limits = QUIET }) {
  const start = now();
  if (midStream(step?.waitAfter) || midStream(next?.waitBefore)) {
    return { rule: QUIET_RULE, skipped: 'mid-stream waitAfter', waitedMs: 0, settled: null, streamsOpen: openStreams(events()) };
  }
  while (openStreams(events()).length && now() - start < limits.streamMs) await sleep(limits.pollMs);
  const streamsOpen = openStreams(events());
  const signature = () => `${events().length}\u0000${fingerprint()}`;
  const windowStart = now();
  let last = signature(), stableSince = now();
  while (now() - stableSince < limits.windowMs) {
    if (now() - windowStart >= limits.maxMs) return { rule: QUIET_RULE, waitedMs: now() - start, streamsOpen, settled: false };
    await sleep(limits.pollMs);
    const current = signature();
    if (current !== last) { last = current; stableSince = now(); }
  }
  return { rule: QUIET_RULE, waitedMs: now() - start, streamsOpen, settled: true };
}
