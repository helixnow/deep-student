import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { constants, accessSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { NativeSandbox, SandboxedProcess, SandboxLaunch } from './api.ts';

const active = new Set<SandboxedProcess>();

function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    // shell_sandbox.rs:785–795 treats an already-exited process group as success.
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

/** setpgid via detached=true; per-child limits via prlimit on Linux / sh builtins on macOS. */
async function launch(request: SandboxLaunch): Promise<SandboxedProcess> {
  if (request.signal?.aborted) throw new Error('cancelled');
  const linux = request.backend === 'linux_bwrap';
  if ((linux && process.platform !== 'linux') || (!linux && process.platform !== 'darwin')) {
    throw new Error(`Sandbox backend ${request.backend} is not available on ${process.platform}`);
  }
  if ((linux && basename(request.program) !== 'bwrap') || (!linux && request.program !== '/usr/bin/sandbox-exec')) {
    throw new Error('Refusing a non-sandbox launcher');
  }
  // Rust isolate_process_group(true): CPU130s, FSIZE4GiB, NPROC2048. prlimit execs
  // the requested launcher in the same PID/group; no shell-quoted command string.
  const program = linux ? '/usr/bin/prlimit' : '/bin/sh';
  const args = linux ? ['--cpu=130:130', '--fsize=4294967296:4294967296', '--nproc=2048:2048', '--', request.program, ...request.args]
    : ['-c', 'ulimit -t 130 && ulimit -f 8388608 && ulimit -u 2048 && exec "$@"', 'sandbox-limits', request.program, ...request.args];
  const child = spawn(program, args, { cwd: request.cwd, env: { ...request.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let ended = false;
  let finish!: (value: { code: number | null; error?: Error }) => void;
  const exited = new Promise<{ code: number | null; error?: Error }>(resolve => { finish = resolve; });
  let spawnError!: (error: Error) => void;
  const spawned = new Promise<void>((resolve, reject) => { spawnError = reject; child.once('spawn', resolve); });
  child.once('error', error => { ended = true; finish({ code: null, error }); spawnError(error); });
  child.once('exit', code => { ended = true; finish({ code }); });
  // Settled by the pipe only, not by 'exit': a byte written just before exit can still be buffered.
  const readyPipe = child.stdio[3] as Readable;
  const ready = new Promise<boolean>(resolve => {
    readyPipe.once('data', () => resolve(true));
    readyPipe.once('close', () => resolve(false));
    readyPipe.on('error', () => resolve(false));
  });
  await spawned;
  const pid = child.pid!;
  if (request.signal?.aborted) {
    killGroup(pid);
    await exited;
    readyPipe.destroy();
    throw new Error('cancelled');
  }
  let cancellationError: Error | undefined;
  const cancel = (): void => {
    try { killGroup(pid); }
    catch (error) { cancellationError = error instanceof Error ? error : new Error(String(error)); }
  };
  request.signal?.addEventListener('abort', cancel, { once: true });
  const unlisten = (): void => request.signal?.removeEventListener('abort', cancel);
  const release = (): void => { readyPipe.destroy(); unlisten(); active.delete(handle); };
  const handle: SandboxedProcess = {
    pid, stdout: child.stdout!, stderr: child.stderr!, ready,
    async wait() {
      const result = await exited;
      if (result.error !== undefined) throw result.error;
      if (cancellationError !== undefined) throw cancellationError;
      return result.code;
    },
    async terminateProcessGroup() { killGroup(pid); await exited; release(); },
    async cleanupFinishedProcessGroup() { killGroup(pid); release(); },
    async cleanupResources() { killGroup(pid); if (!ended) await exited; release(); },
  };
  active.add(handle);
  return handle;
}

export const sandbox: NativeSandbox = {
  spawn: launch,
  async dispose() { await Promise.all([...active].map(handle => handle.cleanupResources())); },
  async probe(backend, program = backend === 'linux_bwrap' ? '/usr/bin/bwrap' : '/usr/bin/sandbox-exec') {
    try {
      accessSync(program, constants.X_OK);
      const args = backend === 'linux_bwrap'
        ? ['--ro-bind', '/', '/', '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session', '--', '/bin/true']
        : ['-p', '(version 1)(allow default)', '/usr/bin/true'];
      const child = await launch({ backend, program, args, cwd: '/', env: { PATH: '/usr/bin:/bin' } });
      let stderr = '';
      const read = (async () => { for await (const bytes of child.stderr) stderr += Buffer.from(bytes).toString('utf8'); })();
      const timer = setTimeout(() => { child.terminateProcessGroup().catch(error => { stderr += String(error); }); }, 5000);
      try {
        const code = await child.wait();
        await read;
        if (code !== 0) return { available: false, reason: stderr || `${program} exited with ${code}` };
        return { available: true, program };
      } finally { clearTimeout(timer); await child.cleanupResources(); }
    } catch (error) { return { available: false, reason: error instanceof Error ? error.message : String(error) }; }
  },
};
