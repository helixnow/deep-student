// Runner-error classes. `infrastructure`: the host refused a thread or process (EAGAIN under a
// TasksMax/pids cap: tokio "can't spawn worker thread … (os error 11)", a std/scheduled-thread-pool
// spawn unwrap, GLib "creating thread 'gmain'", WebKit failing to spawn its web process), so
// the take says nothing about the scenario and is retried, not triaged. Everything else is
// `scenario`. The reason alone often only says "harness timed out" or names a signal, so the
// take's own stderr log (kept by --compact) is read too.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { reusable } from './g3-worker.mjs';

export const INFRASTRUCTURE = [
  { id: 'eagain', pattern: /\bEAGAIN\b/ },
  { id: 'os-error-11', pattern: /\(os error 11\)|\bcode: 11, kind: WouldBlock\b/ },
  { id: 'resource-temporarily-unavailable', pattern: /Resource temporarily unavailable/ },
  { id: 'pthread-create', pattern: /\bpthread_create\b/ },
  { id: 'thread-spawn', pattern: /\b(?:can't|cannot|failed to|unable to) (?:spawn|create) (?:a )?(?:new )?(?:worker )?thread\b/i },
  { id: 'glib-thread', pattern: /\bcreating thread '[^']*'/ },
];
const TAIL_BYTES = 4 << 20;

/** Last TAIL_BYTES of a log (EAGAIN aborts end a log; huge logs are not read whole). */
function tail(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

/** { class: 'infrastructure' | 'scenario', signature: { id, source, line } | null } */
export function classifyRunnerError({ reason = '', logs = [] } = {}) {
  for (const [source, text] of [['reason', String(reason)], ...logs.map(file => [file, tail(file)])]) {
    for (const line of text.split('\n')) {
      const hit = INFRASTRUCTURE.find(signature => signature.pattern.test(line));
      if (hit) return { class: 'infrastructure', signature: { id: hit.id, source, line: line.trim().slice(0, 300) } };
    }
  }
  return { class: 'scenario', signature: null };
}

/** The stderr log of one take beside its shard summary (A: <id>/<A1|A2>/run/app.stderr.log, B: <id>/B/run/host.stderr.log). */
export function takeLogs(shardDirectory, run) {
  const take = run.side ?? 'B';
  const file = join(shardDirectory, run.id, take, 'run', take === 'B' ? 'host.stderr.log' : 'app.stderr.log');
  return existsSync(file) ? [file] : [];
}

/** Runner errors of one shard summary, each with its class. */
export function classifySummary(shardDirectory, summary) {
  return (summary?.runs ?? []).filter(run => run.status === 'runner-error')
    .map(run => ({ id: run.id, side: run.side ?? 'B', ...classifyRunnerError({ reason: run.reason, logs: takeLogs(shardDirectory, run) }) }));
}

export const emptyClasses = () => ({ infrastructure: 0, scenario: 0 });

/** Adds classified runner errors to { infrastructure, scenario } counts and per-signature counts. */
export function tally(classified, counts = emptyClasses(), signatures = {}) {
  for (const item of classified) {
    counts[item.class]++;
    if (item.signature) signatures[item.signature.id] = (signatures[item.signature.id] ?? 0) + 1;
  }
  return { counts, signatures };
}

// Current shard directories only: renamed-aside ones (.superseded-/.rejected-/.partial-) are history.
const SHARD = /^(?:only-[0-9a-f]{12}-)?\d{3}$/;

/** Runner errors of every current, admitted shard of a recording directory, by side (default: the sides it has; old and new batches alike). */
export function scanRunnerErrors(out, sides = ['A', 'B', 'A2'].filter(side => existsSync(join(out, side)))) {
  const result = { counts: {}, signatures: {}, infrastructure: [] };
  for (const side of sides) {
    result.counts[side] = emptyClasses();
    const root = join(out, side);
    if (!existsSync(root)) continue;
    for (const suite of readdirSync(root, { withFileTypes: true })) {
      if (!suite.isDirectory()) continue;
      for (const shard of readdirSync(join(root, suite.name), { withFileTypes: true })) {
        if (!shard.isDirectory() || !SHARD.test(shard.name)) continue;
        const directory = join(root, suite.name, shard.name), file = join(directory, 'summary.json');
        if (!existsSync(file)) continue;
        let summary;
        try { summary = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
        if (!reusable(summary)) continue;
        const classified = classifySummary(directory, summary);
        tally(classified, result.counts[side], result.signatures);
        for (const item of classified) if (item.class === 'infrastructure') result.infrastructure.push({ shard: `${side}/${suite.name}/${shard.name}`, ...item });
      }
    }
  }
  return result;
}
