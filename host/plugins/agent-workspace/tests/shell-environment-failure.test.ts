import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import { ioMessage } from '../src/runtime-paths.ts';
import { tempRoot } from '../src/runtime-roots.ts';
import { errnoCode } from '../src/tools/shell-execute/environment-failure.ts';
import { spawnShellCommand } from '../src/tools/shell-execute/process.ts';
import type { JsonValue, ToolResultInfo } from '../src/tools/shared.ts';
import type { AuthorityMode, PermissionPreset } from '../src/tools/shell-authority.ts';
import {
  LocalShellExecuteExecutor, SHELL_ENVIRONMENT_FAILURE_PREFIX, ShellEnvironmentFailure, sandboxSetupFailure, spawnSandboxCommand,
  type ShellExecuteContext, type SpawnProcess,
} from '../src/tools/shell-execute.ts';
import {
  BWRAP_CANDIDATES, LinuxSandboxBackend, UnsandboxedShellBackend, WindowsPlatformSandboxBackend, sandboxPolicy, type SandboxBackend,
} from '../src/tools/shell-sandbox.ts';

const ID = 'RF-S01-shell-environment-failure';
const posix = process.platform !== 'win32';
/** Platforms whose sandbox backend needs the RLIMIT launcher; the refusal happens before any launcher runs. */
const rlimitBackend = process.platform === 'darwin' || process.platform === 'linux';
const FULL_ACCESS: [AuthorityMode, PermissionPreset] = ['craft', 'full_access'];
const SANDBOXED: [AuthorityMode, PermissionPreset] = ['craft', 'relaxed'];

/** A child that never starts: Node reports the spawn failure on its `error` event, as for a real EAGAIN/ENOENT. */
const refusingSpawn = (code: string, errno: number, spawned: string[]): SpawnProcess => spec => {
  spawned.push(spec.program);
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => child.emit('error', Object.assign(new Error(`spawn ${spec.program} ${code}`), { code, errno, syscall: 'spawn' })));
  return child;
};

interface Run { result: ToolResultInfo; emittedErrors: string[]; saved: ToolResultInfo[] }

/** `execute()` of the executor (the tool-call path: emitted error, saved block, ToolResultInfo). */
async function run(authority: [AuthorityMode, PermissionPreset], command: string, options: {
  native?: boolean; spawn?: SpawnProcess; fromHost?: boolean; timeoutMs?: number; beforeExecute?: () => void;
} = {}): Promise<Run> {
  const { host, storage } = await createWorkspaceHost({ native: options.native ?? false });
  try {
    const sessionId = 'environment';
    const temp = tempRoot(host.app.dataDir, sessionId, true).path;
    const location: Record<string, JsonValue> = authority[1] === 'full_access' ? { cwd: temp } : { root_id: 'temp' };
    const executor = options.fromHost === true
      ? host.ctx.agentWorkspaceTools.createShell()
      : new LocalShellExecuteExecutor(undefined, () => undefined, options.spawn ?? spawnSandboxCommand);
    const emittedErrors: string[] = [];
    const saved: ToolResultInfo[] = [];
    const ctx: ShellExecuteContext = {
      sessionId, dataDir: host.app.dataDir, settings: host.ctx.settings, authority, shellAuthorityAdmission: authority,
      shellGuardApproved: true, blockId: 'blk',
      emitToolCallError: message => { emittedErrors.push(message); },
      saveToolBlock: result => { saved.push(result); },
    };
    options.beforeExecute?.();
    const result = await executor.execute({ id: 'call', name: 'builtin-local_shell_execute', arguments: {
      command, ...location, track_file_changes: false, timeout_ms: options.timeoutMs ?? 10_000,
    } }, ctx);
    return { result, emittedErrors, saved };
  } finally { storage.dispose(); await host.dispose(); }
}

describe(ID, () => {
  const savedTmp = process.env['TMPDIR'];
  afterEach(() => {
    if (savedTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = savedTmp;
  });

  it.skipIf(!posix)(`${ID}: a spawn refused with EAGAIN is an environment failure with the errno and no output, not a command error`, async () => {
    const spawned: string[] = [];
    const eagain = os.constants.errno.EAGAIN;
    const { result, emittedErrors, saved } = await run(FULL_ACCESS, 'echo hi', { spawn: refusingSpawn('EAGAIN', -eagain, spawned) });
    expect(spawned).toHaveLength(1);
    expect(result).toMatchObject({ success: false, output: null, toolCallId: 'call', blockId: 'blk' });
    // Rust: Err("Failed to execute local shell command: Resource temporarily unavailable (os error N)"), indistinguishable from any other tool error.
    expect(result.error).toBe(`${SHELL_ENVIRONMENT_FAILURE_PREFIX} (stage=spawn, code=EAGAIN): Failed to execute local shell command: `
      + `Resource temporarily unavailable (os error ${eagain})\n`
      + 'This is a failure of the local shell execution environment, not of the command. '
      + 'The command did not run, so there is no exit code or output and nothing was changed. '
      + 'EAGAIN means the system is temporarily out of processes, file descriptors or memory. Do not retry the same command right away: '
      + 'wait, retry at most once, and tell the user if it fails again.');
    expect(emittedErrors).toEqual([result.error]);
    expect(saved).toEqual([result]);
  });

  it.skipIf(!posix)(`${ID}: a missing shell (ENOENT) is a permanent environment failure`, async () => {
    const { result } = await run(FULL_ACCESS, 'echo hi', { spawn: refusingSpawn('ENOENT', -os.constants.errno.ENOENT, []) });
    expect(result.error).toBe(`${SHELL_ENVIRONMENT_FAILURE_PREFIX} (stage=spawn, code=ENOENT): Failed to execute local shell command: `
      + `No such file or directory (os error ${os.constants.errno.ENOENT})\n`
      + 'This is a failure of the local shell execution environment, not of the command. '
      + 'The command did not run, so there is no exit code or output and nothing was changed. '
      + 'Retrying the same command will fail the same way. Do not retry it unchanged; tell the user that the local shell '
      + 'environment is not working and quote the reason above.');
  });

  it.skipIf(!posix)('a real spawn failure keeps its errno, so the text reads like the Rust io::Error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's01-spawn-errno-'));
    try {
      const failure = await spawnShellCommand({ program: path.join(dir, 'missing-shell'), args: [], cwd: dir }, {})
        .then(() => null, (error: unknown) => error);
      expect([errnoCode(failure), ioMessage(failure)]).toEqual(['ENOENT', `No such file or directory (os error ${os.constants.errno.ENOENT})`]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(!posix)(`${ID}: a failure without an errno code keeps its original text and gets the do-not-retry advice`, async () => {
    const throwing = (value: unknown): SpawnProcess => () => { throw value; };
    const plain = (await run(FULL_ACCESS, 'echo hi', { spawn: throwing('launcher crashed') })).result;
    expect(plain).toMatchObject({ success: false, output: null });
    expect(plain.error).toBe(`${SHELL_ENVIRONMENT_FAILURE_PREFIX} (stage=spawn): Failed to execute local shell command: launcher crashed\n`
      + 'This is a failure of the local shell execution environment, not of the command. '
      + 'The command did not run, so there is no exit code or output and nothing was changed. '
      + 'Retrying the same command will fail the same way. Do not retry it unchanged; tell the user that the local shell '
      + 'environment is not working and quote the reason above.');
    // Node's own ERR_* codes are not errno values and must not be reported as one.
    const invalid = Object.assign(new TypeError('The "file" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' });
    const node = (await run(FULL_ACCESS, 'echo hi', { spawn: throwing(invalid) })).result;
    expect(node.error).toMatch(new RegExp(`^${SHELL_ENVIRONMENT_FAILURE_PREFIX} \\(stage=spawn\\): `
      + 'Failed to execute local shell command: The "file" argument must be of type string\\n'));
    expect(node.error).toContain('Do not retry it unchanged');
  });

  it.skipIf(!posix)(`${ID}: a command's own non-zero exit and timeout stay structured results without the environment marker`, async () => {
    const exited = (await run(FULL_ACCESS, 'echo out; echo err >&2; exit 3')).result;
    expect(exited).toMatchObject({ success: false, output: { exit_code: 3, timed_out: false, stdout: 'out\n' } });
    expect(exited.error).toMatch(/^Exit code 3/);
    const timedOut = (await run(FULL_ACCESS, 'sleep 30', { timeoutMs: 1_000 })).result;
    expect(timedOut).toMatchObject({ success: false, output: { timed_out: true, exit_code: null } });
    expect(timedOut.error).toMatch(/^Command timed out after 1000ms/);
    for (const error of [exited.error, timedOut.error]) expect(error).not.toContain(SHELL_ENVIRONMENT_FAILURE_PREFIX);
  });

  it.skipIf(!rlimitBackend)(`${ID}: through the plugin's executor, a sandboxed command without the RLIMIT launcher reports a resource_limits failure`, async () => {
    const { result, emittedErrors } = await run(SANDBOXED, 'echo hi', { fromHost: true, native: false });
    expect(result).toMatchObject({ success: false, output: null });
    expect(result.error).toMatch(new RegExp(`^${SHELL_ENVIRONMENT_FAILURE_PREFIX} \\(stage=resource_limits\\): Local shell resource limits are unavailable \\(nativeSandbox service missing\\)`));
    expect(result.error).toContain('Do not retry it unchanged');
    expect(emittedErrors).toEqual([result.error]);
  });

  it.skipIf(process.platform !== 'darwin')(`${ID}: through the plugin's executor, a Seatbelt profile that cannot be written reports a sandbox_setup failure`, async () => {
    const { result } = await run(SANDBOXED, 'echo hi', { fromHost: true, native: true,
      beforeExecute: () => { process.env['TMPDIR'] = path.join(savedTmp ?? '/tmp', 's01-missing-tmpdir', 'gone'); } });
    expect(result).toMatchObject({ success: false, output: null });
    expect(result.error).toMatch(new RegExp(`^${SHELL_ENVIRONMENT_FAILURE_PREFIX} \\(stage=sandbox_setup\\): Failed to create macOS Seatbelt profile: `));
    expect(result.error).toContain('The command did not run');
  });

  describe('fail-closed backends as the model reads them', () => {
    const PERMANENT = 'This is a failure of the local shell execution environment, not of the command. '
      + 'The command did not run, so there is no exit code or output and nothing was changed. '
      + 'Retrying the same command will fail the same way. Do not retry it unchanged; tell the user that the local shell '
      + 'environment is not working and quote the reason above.';
    const cwd = process.cwd();
    const policy = sandboxPolicy({ writable_roots: [cwd] });
    /** What the executor turns a backend's refusal to build the command into. */
    const refusals = (backend: SandboxBackend): string[] => [
      () => backend.command('git status', cwd, policy), () => backend.commandForGit('git status', cwd, policy),
    ].map(build => {
      try { build(); } catch (error) { return sandboxSetupFailure(error).message; }
      throw new Error('expected the backend to refuse');
    });
    const helperMissing = 'The Windows shell helper (AppContainer and Job Object native runtime) is not available in this build';

    it(`${ID}: Windows without the F7 helper refuses both tiers with a readable, permanent sandbox_setup failure`, () => {
      const sandboxed = `${SHELL_ENVIRONMENT_FAILURE_PREFIX} (stage=sandbox_setup): `
        + `Local shell sandbox is unavailable; refusing unsandboxed execution: ${helperMissing}\n${PERMANENT}`;
      expect(refusals(new WindowsPlatformSandboxBackend(process.execPath, () => false))).toEqual([sandboxed, sandboxed]);
      const fullAccess = `${SHELL_ENVIRONMENT_FAILURE_PREFIX} (stage=sandbox_setup): Full Access shell backend is unavailable: ${helperMissing}\n${PERMANENT}`;
      expect(refusals(new UnsandboxedShellBackend('win32', () => false))).toEqual([fullAccess, fullAccess]);
    });

    it.skipIf(BWRAP_CANDIDATES.some(file => fs.existsSync(file)))(`${ID}: Linux without bwrap names the package to install`, () => {
      const missing = `${SHELL_ENVIRONMENT_FAILURE_PREFIX} (stage=sandbox_setup): Local shell sandbox is unavailable; refusing unsandboxed execution: `
        + `Linux bubblewrap launcher (bwrap) was not found; install the 'bubblewrap' package to enable the local shell sandbox\n${PERMANENT}`;
      expect(refusals(new LinuxSandboxBackend(''))).toEqual([missing, missing]);
    });
  });

  it(`${ID}: transient resource errors are told apart from permanent ones; the detail and stage stay readable`, () => {
    const transient = new ShellEnvironmentFailure('spawn', 'Failed to execute local shell command: spawn /bin/sh EMFILE', 'EMFILE');
    expect([transient.stage, transient.code, transient.detail]).toEqual(['spawn', 'EMFILE', 'Failed to execute local shell command: spawn /bin/sh EMFILE']);
    expect(transient.message).toContain('wait, retry at most once');
    const io = new ShellEnvironmentFailure('process_io', 'Failed to capture local shell stdout', null);
    expect(io.message).toMatch(/^LOCAL_SHELL_ENVIRONMENT_FAILURE \(stage=process_io\): Failed to capture local shell stdout\n/);
    expect(io.message).toContain('terminated before its output could be captured');
    expect(io.message).toContain('Do not retry it unchanged');
  });
});
