import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import { tempRoot } from '../src/runtime-roots.ts';
import type { JsonValue } from '../src/tools/shared.ts';
import type { AuthorityMode, PermissionPreset } from '../src/tools/shell-authority.ts';
import { NPROC_PROBE, linuxNprocProbe } from './rlimit-probe.ts';
import { hostPidsWithArgv, uniqueSleepArgv, until } from './host-processes.ts';
import { POSIX_SANDBOX } from './posix-sandbox.ts';

const ULIMITS = `ulimit -t; ulimit -f; ${NPROC_PROBE}`;
const posixSandbox = POSIX_SANDBOX.available;
/** Platforms whose sandbox backend needs the RLIMIT launcher; the refusal happens before any launcher runs. */
const rlimitBackend = process.platform === 'darwin' || process.platform === 'linux';

interface Limits { cpu: number | null; fileBytes: number | null; processes: number | null }

/** `ulimit -t`, `ulimit -f` and NPROC probe lines as limits; `ulimit -f` counts 512-byte blocks. */
function measured(stdout: string): Limits {
  const [cpu, file, processes] = stdout.trim().split('\n').map(line => line.trim());
  const value = (raw: string | undefined, scale = 1): number | null => (raw === 'unlimited' ? null : Number(raw) * scale);
  return { cpu: value(cpu), fileBytes: value(file, 512), processes: value(processes) };
}

function reported(output: JsonValue): Limits {
  const sandbox = (output as { sandbox: Record<string, number | null> }).sandbox;
  return { cpu: sandbox.cpu_time_limit_seconds!, fileBytes: sandbox.file_size_limit_bytes!, processes: sandbox.active_process_limit! };
}

async function runShell(native: boolean, authority: [AuthorityMode, PermissionPreset], command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<JsonValue> {
  const { host, storage } = await createWorkspaceHost({ native });
  try {
    const sessionId = 'limits';
    const temp = tempRoot(host.app.dataDir, sessionId, true).path;
    const location: Record<string, JsonValue> = authority[1] === 'full_access' ? { cwd: temp } : { root_id: 'temp' };
    return await host.ctx.agentWorkspaceTools.createShell().executeShell(
      { command, ...location, track_file_changes: false, timeout_ms: options.timeoutMs ?? 10_000 }, {
        sessionId, dataDir: host.app.dataDir, settings: host.ctx.settings, authority, shellAuthorityAdmission: authority,
        shellGuardApproved: true, ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
  } finally { storage.dispose(); await host.dispose(); }
}

const runUlimits = (native: boolean, authority: [AuthorityMode, PermissionPreset]) => runShell(native, authority, ULIMITS);

describe('NPROC probe', () => {
  it.skipIf(!fs.existsSync('/bin/dash'))('the Linux probe reads the soft Max processes from a limits table under dash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nproc-probe-'));
    try {
      const limits = path.join(dir, 'limits');
      const table = (processes: string) => [
        'Limit                     Soft Limit           Hard Limit           Units     ',
        'Max cpu time              130                  130                  seconds   ',
        `Max processes             ${processes.padEnd(21)}4096                 processes `,
        'Max realtime timeout      unlimited            unlimited            us        ', ''].join('\n');
      const probe = () => execFileSync('/bin/dash', ['-c', linuxNprocProbe(limits)], { encoding: 'utf8' });
      fs.writeFileSync(limits, table('2048'));
      expect(probe()).toBe('2048\n');
      fs.writeFileSync(limits, table('unlimited'));
      expect(probe()).toBe('unlimited\n');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('local_shell_execute resource limits (M2)', () => {
  it.skipIf(!posixSandbox)('sandboxed commands run under RLIMIT CPU 130 s / FSIZE 4 GiB / NPROC 2048, as reported', async () => {
    const output = await runUlimits(true, ['craft', 'relaxed']);
    expect(output).toMatchObject({ success: true, execution_mode: 'sandboxed' });
    const stdout = (output as { stdout: string }).stdout;
    expect(measured(stdout)).toEqual({ cpu: 130, fileBytes: 4 * 1024 ** 3, processes: 2048 });
    expect(reported(output)).toEqual(measured(stdout));
  });

  it.skipIf(!rlimitBackend)('without the native sandbox service a sandboxed command is refused, never run unlimited', async () => {
    await expect(runUlimits(false, ['craft', 'relaxed'])).rejects.toThrow(
      'Local shell resource limits are unavailable (nativeSandbox service missing); refusing to run without RLIMIT CPU/FSIZE/NPROC');
  });

  it.skipIf(process.platform === 'win32')('full access keeps only process-group isolation, like Rust', async () => {
    const output = await runUlimits(true, ['craft', 'full_access']);
    expect(output).toMatchObject({ success: true, execution_mode: 'full_access' });
    expect(reported(output)).toEqual({ cpu: null, fileBytes: null, processes: null });
    expect(measured((output as { stdout: string }).stdout).cpu).toBeNull();
  });

  it.skipIf(!posixSandbox)('a limited command that outlives its timeout is killed with its process group', async () => {
    const started = Date.now();
    const output = await runShell(true, ['craft', 'relaxed'], 'sleep 30', { timeoutMs: 1_000 });
    expect(output).toMatchObject({ success: false, timed_out: true, cancelled: false, exit_code: null });
    expect((output as { stderr: string }).stderr).toContain('Command timed out after 1000ms');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.skipIf(!posixSandbox)('cancelling a limited command terminates the sandbox process tree', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const output = await runShell(true, ['craft', 'relaxed'], 'sleep 30', { timeoutMs: 20_000, signal: controller.signal });
    expect(output).toMatchObject({ success: false, timed_out: false, cancelled: true });
    expect((output as { stderr: string }).stderr).toContain('sandbox process tree was terminated');
  });

  it.skipIf(!posixSandbox)('background children of a finished limited command are reaped', async () => {
    // Under bwrap --unshare-pid the `$!` the command sees is no host PID; find the child by an argv unique to this run.
    const child = uniqueSleepArgv();
    const pending = runShell(true, ['craft', 'relaxed'], `${child.join(' ')} & sleep 2`);
    expect(await until(() => hostPidsWithArgv(child).length > 0, 5_000)).toBe(true);
    const output = await pending;
    expect(output).toMatchObject({ success: true });
    expect(await until(() => hostPidsWithArgv(child).length === 0, 5_000)).toBe(true);
  });
});
