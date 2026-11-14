import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Host-side process checks for shell tests.
 * - A sandboxed command on Linux runs in bwrap's own PID namespace (`--unshare-pid`): the `$!` it prints is not a
 *   host PID, so its children are found on the host by their argv.
 * - A killed process stays a zombie until whoever inherited it reaps it, which a container without an init never
 *   does; a zombie has already exited, so it counts as gone.
 */

/** State letter of a `/proc/<pid>/stat` line (`pid (comm) S …`; comm may itself contain spaces and parentheses). */
export function procStatState(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  const state = close < 0 ? '' : stat.slice(close + 2, close + 3);
  return state === '' ? null : state;
}

/** PIDs of non-zombie processes whose argv is exactly `argv`, read from a Linux `/proc` tree. */
export function procPidsWithArgv(argv: readonly string[], procRoot = '/proc'): number[] {
  const wanted = `${argv.join('\0')}\0`;
  const found: number[] = [];
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (fs.readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8') !== wanted) continue;
      if (procStatState(fs.readFileSync(path.join(procRoot, entry, 'stat'), 'utf8')) === 'Z') continue;
      found.push(Number(entry));
    } catch { /* exited during the scan */ }
  }
  return found.sort((a, b) => a - b);
}

/** The same from `ps -A -o pid= -o stat= -o args=` output (macOS has no /proc). */
export function psPidsWithArgv(listing: string, argv: readonly string[]): number[] {
  const wanted = argv.join(' ');
  const found: number[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s(.*)$/.exec(line);
    if (match === null || match[2]!.startsWith('Z') || match[3]!.trim() !== wanted) continue;
    found.push(Number(match[1]));
  }
  return found.sort((a, b) => a - b);
}

/**
 * A long `sleep` argv to find a test's child by. Random rather than derived from the worker's PID: test workers in
 * other containers or PID namespaces share the host process list and can have the same PID.
 */
export function uniqueSleepArgv(): string[] {
  return ['sleep', String(randomInt(10_000_000, 100_000_000))];
}

export function hostPidsWithArgv(argv: readonly string[]): number[] {
  if (process.platform === 'linux') return procPidsWithArgv(argv);
  return psPidsWithArgv(execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'stat=', '-o', 'args='], { encoding: 'utf8' }), argv);
}

/** Whether host process `pid` is still running; on Linux a zombie is not. */
export function processRunning(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch { return false; }
  if (process.platform !== 'linux') return true;
  try { return procStatState(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) !== 'Z'; }
  catch { return false; }
}

export async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => { setTimeout(resolve, 50); });
  return check();
}
