import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UnsandboxedShellBackend,
  WindowsPlatformSandboxBackend,
  sandboxPolicy,
  shellBackendForExecutionMode,
} from '../src/tools/shell-sandbox.ts';
import {
  ACTIVE_PROCESS_LIMIT,
  HELPER_ARG,
  JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JOB_OBJECT_LIMIT_PROCESS_TIME,
  PROCESS_CPU_TIME_LIMIT_SECS,
  PROFILE_PREFIX,
  encodedPowerShellCommand,
  gitInstallRootFromBash,
  jobLimitInformation,
  payloadPathFromCommand,
  runPayload,
  trustedPowerShellPaths,
  validateWindowsSandboxPayload,
  windowsCommandLine,
  windowsCommandLineArg,
  windowsNativeSandboxAvailable,
  windowsPathsEqual,
  writeWindowsPayload,
} from '../src/tools/shell-sandbox-windows.ts';
import type {
  WindowsCancellationEvent,
  WindowsSandboxPayload,
  WindowsSandboxRuntime,
} from '../src/tools/shell-sandbox-windows.ts';

const tempRoots: string[] = [];

function tempDir(): string {
  const canonicalTmp = fs.realpathSync.native(os.tmpdir());
  const created = fs.mkdtempSync(path.join(canonicalTmp, 'dstu-winsandbox-'));
  tempRoots.push(created);
  return created;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function policy(readable: string, writable: string) {
  return sandboxPolicy({ readable_roots: [readable], writable_roots: [writable] });
}

function payloadFor(
  cwd: string,
  writable: string,
  overrides: Partial<WindowsSandboxPayload> = {},
): WindowsSandboxPayload {
  return {
    command: 'echo ok',
    cwd,
    policy: policy(cwd, writable),
    profile_name: `${PROFILE_PREFIX}${randomUUID().replaceAll('-', '')}`,
    prefer_git_bash: false,
    shell_path: null,
    fallback_shell_path: null,
    ...overrides,
  };
}

const windowsIt = it.skipIf(process.platform !== 'win32');
// F7 native runtime is still pending; on Windows these tests must expose that gap.
const appContainerIt = windowsIt;

describe('windows sandbox payload', () => {
  it('payload_validation_rejects_write_root_other_than_cwd', () => {
    const temp = tempDir();
    const other = tempDir();
    const payload = payloadFor(temp, other);
    expect(() => validateWindowsSandboxPayload(payload)).toThrow(/selected cwd/u);
  });

  it('payload_parent_comparison_uses_windows_path_semantics', () => {
    expect(windowsPathsEqual(
      '\\\\?\\C:\\Users\\Student\\AppData\\Local\\Temp',
      'c:\\users\\student\\appdata\\local\\temp\\',
    )).toBe(true);
    expect(windowsPathsEqual(
      'C:\\Users\\Student\\AppData\\Local\\Temp2',
      'C:\\Users\\Student\\AppData\\Local\\Temp',
    )).toBe(false);
  });

  windowsIt('spawn_failure_cleanup_removes_unconsumed_payload', () => {
    const temp = tempDir();
    const payload = payloadFor(temp, temp);
    const payloadPath = writeWindowsPayload(payload);
    const command = {
      program: process.execPath,
      args: [HELPER_ARG, payloadPath],
      cwd: path.dirname(payloadPath),
    };

    new WindowsPlatformSandboxBackend().cleanupCommandResources(command);

    expect(fs.existsSync(payloadPath)).toBe(false);
  });

  windowsIt('full_access_helper_cwd_stays_at_payload_root', () => {
    const temp = tempDir();
    const backend = new UnsandboxedShellBackend('win32', () => true);
    const command = backend.command('echo ok', temp, policy(temp, temp));
    const payloadPath = payloadPathFromCommand(command);
    expect(payloadPath).not.toBeNull();
    const payloadRoot = path.dirname(payloadPath as string);

    expect(windowsPathsEqual(command.cwd, payloadRoot)).toBe(true);
    backend.cleanupCommandResources(command);
    expect(fs.existsSync(payloadPath as string)).toBe(false);
  });

  it('windows_backends_refuse_without_native_helper_and_write_no_payload', () => {
    expect(windowsNativeSandboxAvailable()).toBe(false);
    const temp = tempDir();
    const localAppData = tempDir();
    const environment = process.env['LOCALAPPDATA'];
    process.env['LOCALAPPDATA'] = localAppData;
    try {
      const helperMissing = 'The Windows shell helper (AppContainer and Job Object native runtime) is not available in this build';
      const sandboxed = new WindowsPlatformSandboxBackend(process.execPath);
      expect(sandboxed.capability()).toEqual({ available: false, reason: helperMissing });
      const refused = `Local shell sandbox is unavailable; refusing unsandboxed execution: ${helperMissing}`;
      expect(() => sandboxed.command('echo ok', temp, policy(temp, temp))).toThrow(refused);
      expect(() => sandboxed.commandForGit('git status', temp, policy(temp, temp))).toThrow(refused);
      expect(sandboxed.effectReport(policy(temp, temp)).enforced).toBe(false);

      const fullAccess = new UnsandboxedShellBackend('win32');
      expect(fullAccess.capability()).toEqual({ available: false, reason: helperMissing });
      const fullRefused = `Full Access shell backend is unavailable: ${helperMissing}`;
      expect(() => fullAccess.command('echo ok', temp, policy(temp, temp))).toThrow(fullRefused);
      expect(() => fullAccess.commandForGit('git status', temp, policy(temp, temp))).toThrow(fullRefused);

      expect(fs.readdirSync(localAppData)).toEqual([]);
    } finally {
      if (environment === undefined) delete process.env['LOCALAPPDATA'];
      else process.env['LOCALAPPDATA'] = environment;
    }
  });

  it('windows_backend_capability_checks_the_launcher_once_the_helper_exists', () => {
    expect(new WindowsPlatformSandboxBackend(process.execPath, () => true).capability()).toEqual({ available: true });
    const missing = path.join(tempDir(), 'missing.exe');
    const capability = new WindowsPlatformSandboxBackend(missing, () => true).capability();
    expect(capability.available).toBe(false);
    expect(capability.available ? '' : capability.reason).toMatch(/^Cannot locate the AppContainer launcher: /u);
  });

  it('unsandboxed_effect_report_honestly_reports_no_resource_limits', () => {
    const backend = new UnsandboxedShellBackend('win32');
    const report = backend.effectReport(sandboxPolicy({
      readable_roots: ['C:\\'],
      writable_roots: ['C:\\'],
    }));
    expect(report.backend).toBe('unsandboxed_job');
    expect(report.enforced).toBe(false);
    expect(report.network_enforced).toBe(false);
    // relaxed Job 只保留 KILL_ON_JOB_CLOSE（进程树回收），报告不得宣称
    // 存在 CPU/文件大小/进程数资源限制。
    expect(report.cpu_time_limit_seconds).toBeNull();
    expect(report.file_size_limit_bytes).toBeNull();
    expect(report.active_process_limit).toBeNull();
  });

  it("RF-S01-windows-unrestricted-job-backend: Windows unrestricted keeps the helper's Job Object backend and reports unsandboxed_job (Rust: direct_host_unrestricted)", () => {
    const policy = sandboxPolicy();
    const helperMissing = 'The Windows shell helper (AppContainer and Job Object native runtime) is not available in this build';
    for (const mode of ['full_access', 'unrestricted'] as const) {
      const backend = shellBackendForExecutionMode(mode, 'win32');
      expect(backend).toBeInstanceOf(UnsandboxedShellBackend);
      expect(backend.effectReport(policy).backend).toBe('unsandboxed_job');
      expect(backend.effectReportForGit(policy).backend).toBe('unsandboxed_job');
      // Rust's DirectHostShellBackend only needs PowerShell; this backend also needs the helper, so a build without it refuses.
      expect(backend.capability()).toEqual({ available: false, reason: helperMissing });
      expect(() => backend.command('echo ok', tempDir(), policy)).toThrow(`Full Access shell backend is unavailable: ${helperMissing}`);
    }
    expect(shellBackendForExecutionMode('sandboxed', 'win32').effectReport(policy).backend).toBe('windows_appcontainer_job');
    for (const platform of ['darwin', 'linux'] as const) {
      expect(shellBackendForExecutionMode('full_access', platform).effectReport(policy).backend).toBe('unsandboxed');
      expect(shellBackendForExecutionMode('unrestricted', platform).effectReport(policy).backend).toBe('unsandboxed');
    }
    expect(shellBackendForExecutionMode('sandboxed', 'darwin').effectReport(policy).backend).toBe('macos_seatbelt');
    expect(shellBackendForExecutionMode('sandboxed', 'linux').effectReport(policy).backend).toBe('linux_bwrap');
  });

  windowsIt('powershell_contract_uses_trusted_binary_encoded_script_and_utf8', () => {
    const candidates = trustedPowerShellPaths();
    const powershell = candidates[0] as string;
    expect(powershell.endsWith('pwsh.exe') || powershell.endsWith('powershell.exe')).toBe(true);
    expect((candidates[candidates.length - 1] as string).endsWith('powershell.exe')).toBe(true);
    expect(candidates.length <= 2).toBe(true);
    if (candidates.length === 2) {
      expect((candidates[0] as string).endsWith('pwsh.exe')).toBe(true);
      expect((candidates[1] as string).endsWith('powershell.exe')).toBe(true);
    }

    const command = "Write-Output '中文 output'";
    const encoded = encodedPowerShellCommand(command);
    const bytes = Buffer.from(encoded, 'base64');
    const words: number[] = [];
    for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
      const low = bytes[offset] ?? 0;
      const high = bytes[offset + 1] ?? 0;
      words.push(low + (high << 8));
    }
    const script = String.fromCharCode(...words);
    expect(script).toContain('[Console]::OutputEncoding = $utf8');
    expect(script).toContain('$OutputEncoding = $utf8');
    expect(script).toContain(command);
    expect(script).toContain('exit $deepStudentExitCode');

    const line = windowsCommandLine(command, false, powershell).command_line;
    expect(line).toContain('-NoProfile -NonInteractive');
    expect(line).toContain('-EncodedCommand');
    expect(line.toUpperCase()).not.toContain('COMSPEC');
  });

  it('git_bash_contract_exposes_install_root_and_initializes_path', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(gitInstallRootFromBash(bash)).toBe('C:\\Program Files\\Git');
    expect(gitInstallRootFromBash('C:\\Program Files\\Git\\usr\\bin\\bash.exe'))
      .toBe('C:\\Program Files\\Git');

    const line = windowsCommandLine('git status --porcelain', true, bash).command_line;
    expect(line).toContain('--noprofile --norc -c');
    expect(line).toContain('export PATH=\\"/cmd:/usr/bin:$PATH\\"; git status --porcelain');
  });

  it('windows_argv_quoting_preserves_quotes_and_trailing_backslashes', () => {
    expect(windowsCommandLineArg('plain')).toBe('"plain"');
    expect(windowsCommandLineArg('a"b')).toBe('"a\\"b"');
    expect(windowsCommandLineArg('a\\')).toBe('"a\\\\"');
  });

  it('job_limits_bound_cpu_and_active_processes', () => {
    const limits = jobLimitInformation();
    expect(limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
      .not.toBe(0);
    expect(limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_ACTIVE_PROCESS)
      .not.toBe(0);
    expect(limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_PROCESS_TIME)
      .not.toBe(0);
    expect(limits.BasicLimitInformation.ActiveProcessLimit).toBe(ACTIVE_PROCESS_LIMIT);
    expect(limits.BasicLimitInformation.PerProcessUserTimeLimit)
      .toBe(PROCESS_CPU_TIME_LIMIT_SECS * 10_000_000);
  });

  appContainerIt('appcontainer_writes_only_inside_selected_cwd', () => {
    const writable = tempDir();
    const outside = tempDir();
    const insideFile = path.join(writable, 'inside.txt');
    const outsideFile = path.join(outside, 'outside.txt');
    const command = [
      `Set-Content -LiteralPath '${insideFile}' -Value inside`,
      `Set-Content -LiteralPath '${outsideFile}' -Value outside`,
    ].join('; ');
    const payload = payloadFor(writable, writable, { command });
    expect(windowsNativeSandboxAvailable()).toBe(true);
    runPayload(payload, null);
    expect(fs.existsSync(insideFile)).toBe(true);
    expect(fs.existsSync(outsideFile)).toBe(false);
  });

  appContainerIt('appcontainer_blocks_protected_subdirectory_writes', () => {
    const writable = tempDir();
    const protectedRoot = path.join(writable, '.git');
    fs.mkdirSync(protectedRoot);
    const executed = path.join(writable, 'executed.txt');
    const blockedFile = path.join(protectedRoot, 'config');
    const outside = tempDir();
    const outsideFile = path.join(outside, 'outside.txt');
    const sandboxPolicyValue = policy(writable, writable);
    sandboxPolicyValue.protected_write_roots.push(protectedRoot);
    const payload = payloadFor(writable, writable, {
      policy: sandboxPolicyValue,
      command: [
        `Set-Content -LiteralPath '${executed}' -Value executed`,
        `Set-Content -LiteralPath '${blockedFile}' -Value blocked`,
        `Set-Content -LiteralPath '${outsideFile}' -Value outside`,
      ].join('; '),
    });
    expect(windowsNativeSandboxAvailable()).toBe(true);
    runPayload(payload, null);
    expect(fs.existsSync(executed)).toBe(true);
    expect(fs.existsSync(blockedFile)).toBe(false);
    expect(fs.existsSync(outsideFile)).toBe(false);
  });

  appContainerIt('appcontainer_denies_network_without_capability', async () => {
    const writable = tempDir();
    const { createServer } = await import('node:net');
    const server = createServer();
    let connected = false;
    server.on('connection', socket => {
      connected = true;
      socket.destroy();
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address !== 'object') {
          reject(new Error('no probe port'));
          return;
        }
        resolve(address.port);
      });
    });
    const payload = payloadFor(writable, writable, {
      command: `curl.exe --silent --max-time 2 http://127.0.0.1:${port}/ *> $null`,
    });
    try {
      expect(windowsNativeSandboxAvailable()).toBe(true);
      runPayload(payload, null);
      await new Promise(resolve => { setTimeout(resolve, 4_000); });
      expect(connected).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve(); });
      });
    }
  }, 10_000);

  appContainerIt('cancellation_prevents_late_process_launch', () => {
    const writable = tempDir();
    const output = path.join(writable, 'late.txt');
    const event: WindowsCancellationEvent = { isSignaled: () => true };
    const runtime: WindowsSandboxRuntime = {
      createCancellationEvent: () => event,
      acquireAclMutex: () => null,
      createProfile: () => {
        throw new Error('cancelled before profile creation');
      },
      grantPolicy: () => ({ granted_paths: [], protected_paths: [] }),
      revokePolicy: () => undefined,
      runUnsandboxedJobProcess: () => 0,
      runAppContainerProcess: () => 0,
      writeStderr: () => undefined,
    };
    const payload = payloadFor(writable, writable, {
      command: `Set-Content -LiteralPath '${output}' -Value late`,
    });
    expect(runPayload(payload, event, runtime)).toBe(124);
    expect(fs.existsSync(output)).toBe(false);
  });
});
