// Supervised child processes for the G3 recorders. A process is finished only when it
// has exited AND its stdout/stderr reached EOF, and both waits are bounded: a descendant
// that keeps the pipes open after the leader exited is killed (same process group) or
// cut off (own session). Timeouts and stop() escalate SIGTERM → SIGKILL to the whole
// process group. The receipt carries the real exit code and signal; nothing here throws.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const PROCESS_SCHEMA = 'g3-process/v1';
export const OUTCOMES = ['exited', 'signaled', 'timeout', 'stopped', 'spawn-error', 'unkillable'];

const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/**
 * Start `command` in its own process group. Returns a handle:
 *  - `exited`: resolves `{code, signal, error}` when the leader exits (or fails to spawn);
 *  - `done`: resolves the receipt once exit and stdio EOF are settled (or forced);
 *  - `stop(reason)`: SIGTERM → killGraceMs → SIGKILL to the group if still running; returns `done`.
 */
export function startSupervised(command, args = [], options = {}) {
  const { cwd, env, label = command, logFile = null, onStdout = null, onStderr = null, captureStdout = true,
    timeoutMs = 0, killGraceMs = 10_000, closeGraceMs = 10_000 } = options;
  const receipt = { schema: PROCESS_SCHEMA, label, command, args, pid: null,
    startedAt: new Date().toISOString(), endedAt: null, durationMs: null,
    code: null, signal: null, exitedAt: null, closedAt: null, stdio: 'open',
    timeout: { ms: timeoutMs || null, fired: false }, stopReason: null, escalation: [], leftovers: false,
    outcome: null, ok: false, error: null };
  const started = Date.now();
  const timers = new Set();
  const later = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
  const waitFor = (promise, ms) => new Promise(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(false); }, ms);
    timers.add(timer);
    promise.then(() => { clearTimeout(timer); timers.delete(timer); resolve(true); });
  });
  const exited = Promise.withResolvers();
  const done = Promise.withResolvers();
  let stdout = '';
  let hasExited = false, terminating = false, finished = false;

  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  receipt.pid = child.pid ?? null;

  const signalGroup = (signal, reason) => {
    const step = { signal, at: new Date().toISOString(), reason, target: 'group', delivered: false };
    try { process.kill(-child.pid, signal); step.delivered = true; }
    catch (error) {
      if (error.code !== 'ESRCH') step.error = error.code;
      // No group left: only a leader that moved to another group can still be running.
      if (!hasExited) { step.target = 'process'; step.delivered = child.kill(signal); }
    }
    receipt.escalation.push(step);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    // Members of the group that outlived the leader (and already closed stdio) do not outlive the receipt.
    if (receipt.pid && hasExited && !receipt.escalation.some(step => step.signal === 'SIGKILL') && groupAlive(receipt.pid)) {
      receipt.leftovers = true;
      try { process.kill(-receipt.pid, 'SIGKILL'); } catch { /* raced with their exit */ }
    }
    receipt.endedAt = new Date().toISOString();
    receipt.durationMs = Date.now() - started;
    if (receipt.pid === null) receipt.outcome = 'spawn-error';
    else if (!hasExited) receipt.outcome = 'unkillable';
    else if (receipt.timeout.fired) receipt.outcome = 'timeout';
    else if (receipt.stopReason !== null) receipt.outcome = 'stopped';
    else if (receipt.signal !== null) receipt.outcome = 'signaled';
    else receipt.outcome = 'exited';
    receipt.ok = receipt.outcome === 'exited' && receipt.code === 0 && receipt.stdio === 'closed';
    done.resolve({ ...receipt, stdout });
  };

  // stdout/stderr did not reach EOF in time: kill whatever is left in the group, then stop reading.
  const forceClose = reason => {
    if (finished || receipt.stdio !== 'open') return;
    receipt.stdio = 'forced';
    if (receipt.pid && groupAlive(receipt.pid) && !receipt.escalation.some(step => step.signal === 'SIGKILL')) signalGroup('SIGKILL', reason);
    child.stdout?.destroy();
    child.stderr?.destroy();
    later(1_000, finish); // 'close' normally follows the destroy at once
  };

  const terminate = async reason => {
    if (terminating || hasExited || finished) return;
    terminating = true;
    signalGroup('SIGTERM', reason);
    if (await waitFor(exited.promise, killGraceMs)) return;
    signalGroup('SIGKILL', reason);
    if (await waitFor(exited.promise, killGraceMs)) return;
    receipt.error = `pid ${receipt.pid} did not exit within ${killGraceMs}ms of SIGKILL`;
    forceClose(reason);
    later(0, finish);
  };

  const sink = (callback, capture) => chunk => {
    if (capture) stdout += chunk;
    if (logFile) appendFileSync(logFile, chunk);
    callback?.(chunk);
  };
  child.stdout?.on('data', sink(onStdout, captureStdout));
  child.stderr?.on('data', sink(onStderr, false));
  child.on('error', error => {
    receipt.error = String(error?.message ?? error);
    if (receipt.pid === null) { exited.resolve({ code: null, signal: null, error }); later(0, finish); }
  });
  child.on('exit', (code, signal) => {
    hasExited = true;
    Object.assign(receipt, { code, signal, exitedAt: new Date().toISOString() });
    exited.resolve({ code, signal, error: null });
    later(closeGraceMs, () => forceClose('stdio held open after exit'));
  });
  child.on('close', () => {
    if (receipt.stdio === 'open') receipt.stdio = 'closed';
    receipt.closedAt = new Date().toISOString();
    if (hasExited || receipt.pid === null) finish();
  });
  if (timeoutMs > 0) later(timeoutMs, () => { if (!hasExited) { receipt.timeout.fired = true; terminate('timeout'); } });

  return {
    pid: receipt.pid, child, receipt,
    exited: exited.promise,
    done: done.promise,
    stop(reason = 'stopped') {
      if (!hasExited && !finished) {
        receipt.stopReason ??= reason;
        terminate(reason);
      }
      return done.promise;
    },
  };
}

/** The receipt as written to disk (captured stdout stays with the caller). */
export function processRecord({ stdout, ...receipt }) { return receipt; }
