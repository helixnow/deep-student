import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SANDBOX_CPU_TIME_LIMIT_SECS,
  SANDBOX_FILE_SIZE_LIMIT_BYTES,
  SANDBOX_PROCESS_LIMIT,
  LinuxSandboxBackend,
  MacOsSandboxBackend,
  UnsandboxedShellBackend,
  bwrapArgs,
  profilePathFromCommand,
  sandboxPolicy,
  seatbeltProfile,
  writeProfileFile,
} from '../src/tools/shell-sandbox.ts';

const tempRoots: string[] = [];

function tempDir(): string {
  const canonicalTmp = fs.realpathSync.native(os.tmpdir());
  const created = fs.mkdtempSync(path.join(canonicalTmp, 'dstu-sandbox-'));
  tempRoots.push(created);
  return created;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function containsSequence(args: readonly string[], expected: readonly string[]): boolean {
  for (let start = 0; start + expected.length <= args.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (args[start + offset] !== expected[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

const nonWindowsIt = it.skipIf(process.platform !== 'linux');
const macIt = it.skipIf(process.platform !== 'darwin');
const seatbeltIntegrationIt = macIt;
const unixIt = it.skipIf(process.platform === 'win32');

describe('sandbox setup errors carry the Rust io::Error text', () => {
  unixIt('a policy root that cannot be canonicalized reports strerror and the os error number', () => {
    const missing = path.join(tempDir(), 'missing');
    const expected = `Failed to canonicalize sandbox policy path '${missing}': No such file or directory (os error 2)`;
    expect(() => bwrapArgs('true', tempDir(), sandboxPolicy({ writable_roots: [missing] }))).toThrow(expected);
    expect(() => seatbeltProfile(sandboxPolicy({ writable_roots: [missing] }))).toThrow(expected);
  });

  unixIt('a Seatbelt profile that cannot be created reports strerror and the os error number', () => {
    const missing = path.join(tempDir(), 'missing');
    expect(() => writeProfileFile('(version 1)', missing))
      .toThrow('Failed to create macOS Seatbelt profile: No such file or directory (os error 2)');
  });
});

describe('linux bubblewrap argument construction', () => {
  nonWindowsIt('bwrap_args_readonly_root_and_writable_remount_and_no_network', () => {
    const temp = tempDir();
    const writable = path.join(temp, 'writable');
    const protectedRoot = path.join(writable, '.git');
    fs.mkdirSync(protectedRoot, { recursive: true });
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [writable],
      protected_write_roots: [protectedRoot],
    });
    const args = bwrapArgs('printf ok', writable, policy);

    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(containsSequence(args, ['--dev', '/dev'])).toBe(true);
    expect(containsSequence(args, ['--proc', '/proc'])).toBe(true);
    const writableCanonical = fs.realpathSync.native(writable);
    expect(containsSequence(args, ['--bind', writableCanonical, writableCanonical])).toBe(true);
    const protectedCanonical = fs.realpathSync.native(protectedRoot);
    expect(containsSequence(args, ['--ro-bind', protectedCanonical, protectedCanonical])).toBe(true);
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--new-session');
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'printf ok']);
  });

  nonWindowsIt('bwrap_args_allow_network_omits_unshare_net', () => {
    const temp = tempDir();
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [temp],
      allow_network: true,
    });
    const args = bwrapArgs('printf ok', temp, policy);
    expect(args).not.toContain('--unshare-net');
    expect(args).toContain('--unshare-pid');
  });

  nonWindowsIt('bwrap_args_mask_protected_read_dirs_and_files', () => {
    const temp = tempDir();
    const secretDirectory = path.join(temp, '.ssh');
    const secretFile = path.join(temp, '.netrc');
    fs.mkdirSync(secretDirectory, { recursive: true });
    fs.writeFileSync(secretFile, 'secret');
    const policy = sandboxPolicy({
      readable_roots: [temp],
      protected_read_roots: [secretDirectory, secretFile],
    });
    const args = bwrapArgs('printf ok', temp, policy);
    expect(containsSequence(args, ['--tmpfs', fs.realpathSync.native(secretDirectory)])).toBe(true);
    expect(containsSequence(args, ['--ro-bind', '/dev/null', fs.realpathSync.native(secretFile)]))
      .toBe(true);
  });

  nonWindowsIt('bwrap_args_strict_read_mode_uses_empty_root_and_rebinds_only_allowed_path', () => {
    const temp = tempDir();
    const job = path.join(temp, 'job');
    fs.mkdirSync(job, { recursive: true });
    const policy = sandboxPolicy({
      readable_roots: [job],
      writable_roots: [job],
      restrict_read_to_roots: true,
    });
    const args = bwrapArgs('printf ok', job, policy);

    expect(args.slice(0, 2)).toEqual(['--tmpfs', '/']);
    // strict mode must never expose the host root
    expect(containsSequence(args, ['--ro-bind', '/', '/'])).toBe(false);
    const jobCanonical = fs.realpathSync.native(job);
    expect(containsSequence(args, ['--ro-bind', jobCanonical, jobCanonical])).toBe(true);
    expect(containsSequence(args, ['--bind', jobCanonical, jobCanonical])).toBe(true);
  });

  nonWindowsIt('bwrap_args_pass_paths_with_spaces_verbatim', () => {
    const temp = tempDir();
    const spaced = path.join(temp, 'dir with spaces');
    fs.mkdirSync(spaced, { recursive: true });
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [spaced],
    });
    const spacedCanonical = fs.realpathSync.native(spaced);
    const args = bwrapArgs('printf ok', spacedCanonical, policy);
    // 路径直接进 exec 数组，不做任何 shell 转义
    expect(args).toContain(spacedCanonical);
    expect(containsSequence(args, ['--chdir', spacedCanonical])).toBe(true);
  });

  nonWindowsIt('effect_report_exposes_resource_limits_and_contract', () => {
    const temp = tempDir();
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [temp],
    });
    const report = new LinuxSandboxBackend().effectReport(policy);
    expect(report.backend).toBe('linux_bwrap');
    expect(report.shell_kind).toBe('posix_sh');
    expect(report.output_encoding).toBe('utf-8');
    expect(report.network_enforced).toBe(true);
    expect(report.process_group_isolated).toBe(true);
    expect(report.cpu_time_limit_seconds).toBe(SANDBOX_CPU_TIME_LIMIT_SECS);
    expect(report.file_size_limit_bytes).toBe(SANDBOX_FILE_SIZE_LIMIT_BYTES);
    expect(report.active_process_limit).toBe(SANDBOX_PROCESS_LIMIT);
    expect(report.readable_roots).toBe(1);
    expect(report.writable_roots).toBe(1);
  });
});

describe('macOS seatbelt profile construction', () => {
  macIt('profile_denies_network_and_protects_write_roots', () => {
    const temp = tempDir();
    const readable = path.join(temp, 'readable');
    const writable = path.join(temp, 'writable');
    const protectedRoot = path.join(writable, 'protected');
    fs.mkdirSync(readable, { recursive: true });
    fs.mkdirSync(protectedRoot, { recursive: true });
    const policy = sandboxPolicy({
      readable_roots: [readable],
      writable_roots: [writable],
      protected_write_roots: [protectedRoot],
    });
    const rendered = seatbeltProfile(policy);
    expect(rendered).toContain('(deny network*)');
    expect(rendered).toContain('(allow file-write*');
    expect(rendered).toContain('(deny file-write*');
    expect(rendered).toContain(readable);

    const report = new MacOsSandboxBackend().effectReport(policy);
    expect(report.cpu_time_limit_seconds).toBe(SANDBOX_CPU_TIME_LIMIT_SECS);
    expect(report.file_size_limit_bytes).toBe(SANDBOX_FILE_SIZE_LIMIT_BYTES);
    expect(report.active_process_limit).toBe(SANDBOX_PROCESS_LIMIT);
  });

  seatbeltIntegrationIt('seatbelt_blocks_write_outside_writable_roots', () => {
    const temp = tempDir();
    const allowed = path.join(temp, 'allowed');
    const blocked = path.join(temp, 'blocked');
    fs.mkdirSync(allowed, { recursive: true });
    fs.mkdirSync(blocked, { recursive: true });
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [allowed],
    });
    const backend = new MacOsSandboxBackend();
    const commandText = `printf blocked > '${blocked}/escape.txt'`;
    const command = backend.command(commandText, allowed, policy);
    const result = spawnSync(command.program, command.args, { cwd: command.cwd, encoding: 'utf8' });
    backend.cleanupCommandResources(command);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(blocked, 'escape.txt'))).toBe(false);
  });

  seatbeltIntegrationIt('seatbelt_allows_shell_operators_interpreters_and_children_inside_root', () => {
    const temp = tempDir();
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [temp],
    });
    const backend = new MacOsSandboxBackend();
    const script = "sh -c 'printf child > child.txt' && awk 'BEGIN { print \"awk\" }' > interpreter.txt";
    const command = backend.command(script, temp, policy);
    const result = spawnSync(command.program, command.args, { cwd: command.cwd, encoding: 'utf8' });
    backend.cleanupCommandResources(command);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(fs.readFileSync(path.join(temp, 'child.txt'), 'utf8')).toBe('child');
    expect(fs.readFileSync(path.join(temp, 'interpreter.txt'), 'utf8')).toBe('awk\n');
  });

  seatbeltIntegrationIt('seatbelt_allows_script_runner_while_network_is_denied', () => {
    const temp = tempDir();
    const developerDir = findDeveloperDir();
    const readableRoots = [temp];
    if (developerDir !== null) readableRoots.push(developerRootOf(developerDir));
    const policy = sandboxPolicy({
      readable_roots: readableRoots,
      writable_roots: [temp],
    });
    const backend = new MacOsSandboxBackend();
    const command = backend.command("python3 -c 'print(\"offline-runner-ok\")'", temp, policy);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: temp,
      TEMP: temp,
      TMP: temp,
    };
    if (developerDir !== null) {
      environment['DEVELOPER_DIR'] = developerDir;
      const developerBin = path.join(developerDir, 'usr/bin');
      if (isDirectory(developerBin)) {
        environment['PATH'] = [developerBin, process.env['PATH'] ?? ''].join(path.delimiter);
      }
    }
    const result = spawnSync(command.program, command.args, {
      cwd: command.cwd,
      encoding: 'utf8',
      env: environment,
    });
    backend.cleanupCommandResources(command);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe('offline-runner-ok\n');
  });

  seatbeltIntegrationIt('seatbelt_denies_network_even_to_loopback', async () => {
    const probe = await probeLoopbackPort();
    const temp = tempDir();
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [temp],
    });
    const backend = new MacOsSandboxBackend();
    const command = backend.command(`nc -G 1 -z 127.0.0.1 ${probe.port}`, temp, policy);
    const result = spawnSync(command.program, command.args, { cwd: command.cwd });
    backend.cleanupCommandResources(command);
    expect(result.status).not.toBe(0);
    probe.close();
  });

  seatbeltIntegrationIt('timeout_kills_descendant_process_group', async () => {
    const temp = tempDir();
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [temp],
    });
    const backend = new MacOsSandboxBackend();
    const command = backend.command('sleep 30 & echo $! > descendant.pid; wait', temp, policy);
    const child = spawnDetached(command);
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(path.join(temp, 'descendant.pid'))) {
      if (Date.now() > deadline) throw new Error('descendant pid file was not created');
      await sleep(10);
    }
    const descendantPid = Number(fs.readFileSync(path.join(temp, 'descendant.pid'), 'utf8').trim());
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    await waitForExit(child);
    backend.cleanupCommandResources(command);

    const goneBy = Date.now() + 2_000;
    let gone = false;
    while (Date.now() < goneBy) {
      try {
        process.kill(descendantPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          gone = true;
          break;
        }
      }
      await sleep(10);
    }
    expect(gone, 'descendant process survived process-group kill').toBe(true);
  });

  macIt('seatbelt_profile_is_private_temp_file_and_not_inline_argv', () => {
    const temp = tempDir();
    const policy = sandboxPolicy({
      readable_roots: [temp],
      writable_roots: [temp],
    });
    const backend = new MacOsSandboxBackend();
    const command = backend.command('printf ok', temp, policy);
    const profilePath = profilePathFromCommand(command);
    expect(profilePath).not.toBeNull();
    const profileMetadata = fs.statSync(profilePath as string);

    expect(profileMetadata.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(profilePath as string, 'utf8')).toContain('(deny default)');
    expect(command.args.some(argument => argument.includes('(deny default)'))).toBe(false);

    backend.cleanupCommandResources(command);
    expect(fs.existsSync(profilePath as string)).toBe(false);
  });

  unixIt('danger_backend_is_explicit_unsandboxed_posix_shell_with_limits', () => {
    const temp = tempDir();
    const policy = sandboxPolicy({ allow_network: true });
    const backend = new UnsandboxedShellBackend(process.platform);
    const command = backend.command('printf ok', temp, policy);
    expect(command.program).toBe('/bin/sh');
    expect(command.args).toEqual(['-c', 'printf ok']);
    const report = backend.effectReport(policy);
    expect(report.backend).toBe('unsandboxed');
    expect(report.enforced).toBe(false);
    expect(report.network_enforced).toBe(false);
    expect(report.process_group_isolated).toBe(true);
    // 完全信任通道不施加 RLIMIT 资源上限
    expect(report.cpu_time_limit_seconds).toBeNull();
    expect(report.file_size_limit_bytes).toBeNull();
    expect(report.active_process_limit).toBeNull();
  });
});

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function findDeveloperDir(): string | null {
  const result = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout === null) return null;
  const selected = result.stdout.trim();
  return isDirectory(selected) ? selected : null;
}

function developerRootOf(selected: string): string {
  return selected.endsWith(path.join('Contents', 'Developer'))
    ? path.dirname(path.dirname(selected))
    : selected;
}

function probeLoopbackPort(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address !== 'object') {
        reject(new Error('loopback probe has no port'));
        return;
      }
      resolve({ port: address.port, close: () => { server.close(); } });
    });
  });
}

function spawnDetached(command: { program: string; args: string[]; cwd: string }): ChildProcess {
  return spawn(command.program, command.args, { cwd: command.cwd, detached: true, stdio: 'ignore' });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds); });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.on('exit', () => { resolve(); });
  });
}
