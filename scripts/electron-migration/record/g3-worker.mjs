// Worker process plumbing for g3-batch.mjs: the namespace wrapper, one supervised worker
// process per shard, and the rule that decides whether a shard's summary may be used.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { processRecord, startSupervised } from './supervise.mjs';
import { MCP_DIR } from './g3-services.mjs';

export const WORKER_SCHEMA = 'g3-worker/v1';

// PID 1 of a fresh user+network+PID namespace. The payload must not be PID 1 itself:
// Xvfb notifies its parent only when that pid is > 1 (xorg-server os/connection.c
// NotifyParentProcess), so an exec'd xvfb-run waits for SIGUSR1 forever. Signals from
// outside reach a namespace init only if it handles them, so TERM/INT/HUP are trapped and
// passed to every process in the namespace. When this shell exits, the kernel kills
// whatever is left in the namespace; --kill-child does the same if the outer unshare dies.
// Outside a PID namespace `kill -1` would reach every process of the user, hence the guard.
// --mount-proc gives the namespace its own (private) mounts: a tmpfs over MCP_DIR is this
// worker's alone, so the MCP service's fixed directory (g3-services.mjs) never collides with
// another worker's. Without it MCP scenarios refuse to run; nothing else depends on it.
export const MCP_MOUNT = MCP_DIR;
export const NAMESPACE_INIT = [
  '[ "$$" = 1 ] || { echo "g3-worker: namespace init is not pid 1" >&2; exit 98; }',
  "trap 'kill -TERM -1 2>/dev/null' TERM INT HUP",
  'ip link set lo up || exit 97',
  `{ mkdir -p ${MCP_MOUNT} && mount -t tmpfs -o mode=0700,size=64m g3-mcp ${MCP_MOUNT} && export G3_MCP_DIR=${MCP_MOUNT}; } || echo "g3-worker: no private ${MCP_MOUNT}; MCP scenarios will refuse to run" >&2`,
  '"$@" &',
  'payload=$!',
  'while :; do wait "$payload"; status=$?; kill -0 "$payload" 2>/dev/null || exit "$status"; done',
].join('\n');
export const NAMESPACE = ['nice', '-n', '10', 'unshare', '-rnpf', '--mount-proc', '--kill-child', 'bash', '-c', NAMESPACE_INIT, 'g3-worker'];

/**
 * One worker process under supervision. `children` (a Set) holds the live handles so a
 * batch shutdown can stop() them. Resolves the process receipt plus captured stdout.
 */
export async function runWorker(command, args, { logFile, children = null, cwd, env, label, timeoutMs = 0, killGraceMs = 30_000, closeGraceMs = 30_000 } = {}) {
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  const handle = startSupervised(command, args, { cwd, env, label, logFile, timeoutMs, killGraceMs, closeGraceMs });
  children?.add(handle);
  try { return await handle.done; } finally { children?.delete(handle); }
}

/**
 * The shard summary a worker left behind, annotated for the batch; null when it must not
 * be used. g3-run-a/b exit 0 when every scenario recorded or was unsupported and 1 when
 * at least one was a runner-error; anything else (a signal, a timeout, a forced stdio
 * close, a crash code, or a code that disagrees with the summary) rejects the shard.
 */
export function acceptSummary(summaryFile, result, annotations = {}) {
  if (!existsSync(summaryFile)) return null;
  if (result.outcome !== 'exited' || result.stdio !== 'closed') return null;
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  const runnerErrors = (summary.runs ?? []).filter(item => item.status === 'runner-error').length;
  if (!((result.code === 0 && runnerErrors === 0) || (result.code === 1 && runnerErrors > 0))) return null;
  return { ...summary, ...annotations, runnerCode: result.code,
    worker: { outcome: result.outcome, ok: result.ok, code: result.code, signal: result.signal, stdio: result.stdio, durationMs: result.durationMs } };
}

/** A previously admitted summary may be reused only if it went through acceptSummary. */
export function reusable(summary) {
  return summary?.worker?.outcome === 'exited' && summary.worker.stdio === 'closed'
    && (summary.runnerCode === 0 || summary.runnerCode === 1);
}

const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Per-shard worker receipt: the real process outcome, the summary it produced, and the
 * sha256 of every trace it recorded. g3-report admits a trace only through one of these.
 */
export function writeWorkerReceipt(out, { side, shard, recording, result, logFile, summaryFile, admitted, rejectedTo = null }) {
  const file = join(out, 'receipts', side, `${shard.key.replaceAll('/', '__')}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const traces = admitted ? admitted.runs.filter(item => item.status === 'recorded')
    .map(item => ({ id: item.id, take: item.side ?? side, file: item.trace, sha256: sha256File(item.trace) })) : [];
  const receipt = { schema: WORKER_SCHEMA, side, shard: shard.key, scenarioFile: shard.file, ids: shard.ids,
    recording, process: processRecord(result), log: logFile,
    summary: admitted ? { file: summaryFile, sha256: sha256File(summaryFile) } : null,
    admitted: Boolean(admitted), rejectedTo, traces, writtenAt: new Date().toISOString() };
  writeFileSync(`${file}.tmp`, JSON.stringify(receipt, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  return { file, receipt };
}
