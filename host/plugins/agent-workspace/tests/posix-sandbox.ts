import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Whether this host can run the sandboxed local shell the way host/platform/native/sandbox launches it, so tests
 * skip only on a capability the host lacks:
 * - macOS: `sandbox-exec` must be able to apply a profile (it cannot inside another Seatbelt sandbox);
 * - Linux: `/usr/bin/prlimit` (hard-coded by the launcher) must set the RLIMITs and bwrap must create its user,
 *   network and PID namespaces and mount /proc. Installed is not enough: Ubuntu 24.04's AppArmor user-namespace
 *   restriction and Docker's default seccomp profile refuse it.
 * The probe arguments are fixed here, independent of the product's bwrap arguments, so a regression in those
 * still fails the tests instead of skipping them.
 */
export interface SandboxCapability { available: boolean; reason: string }

export interface ProbeHost {
  exists(file: string): boolean;
  run(program: string, args: readonly string[]): { status: number | null; stderr: string };
}

export const PRLIMIT = '/usr/bin/prlimit';
export const BWRAP_LOCATIONS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'] as const;
const LIMITS = ['--cpu=130:130', '--fsize=4294967296:4294967296', '--nproc=2048:2048'];
const NAMESPACES = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
  '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session'];

const nodeProbeHost: ProbeHost = {
  exists: file => fs.existsSync(file),
  run: (program, args) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'ignore', 'pipe'] });
    return { status: result.status, stderr: result.error === undefined ? result.stderr : result.error.message };
  },
};

function refused(launcher: string, result: { status: number | null; stderr: string }): SandboxCapability {
  const detail = result.stderr.trim() === '' ? `exit status ${String(result.status)}` : result.stderr.trim();
  return { available: false, reason: `${launcher} is installed but refused to sandbox a command here: ${detail}` };
}

export function probePosixSandbox(platform: NodeJS.Platform, host: ProbeHost = nodeProbeHost,
  searchPath: string | undefined = process.env['PATH']): SandboxCapability {
  if (platform === 'darwin') {
    const result = host.run('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
    return result.status === 0 ? { available: true, reason: 'sandbox-exec applies profiles' } : refused('sandbox-exec', result);
  }
  if (platform !== 'linux') return { available: false, reason: `no POSIX shell sandbox on ${platform}` };
  if (!host.exists(PRLIMIT)) return { available: false, reason: `${PRLIMIT} is not installed (util-linux)` };
  const onPath = (searchPath ?? '').split(':').filter(directory => directory.startsWith('/')).map(directory => `${directory}/bwrap`);
  const bwrap = [...BWRAP_LOCATIONS, ...onPath].find(file => host.exists(file));
  if (bwrap === undefined) return { available: false, reason: 'bwrap is not installed (bubblewrap)' };
  const result = host.run(PRLIMIT, [...LIMITS, '--', bwrap, ...NAMESPACES, '--', '/bin/sh', '-c', 'exit 0']);
  return result.status === 0 ? { available: true, reason: `${bwrap} creates namespaces under prlimit` } : refused(bwrap, result);
}

export const POSIX_SANDBOX: SandboxCapability = probePosixSandbox(process.platform);
if (!POSIX_SANDBOX.available && (process.platform === 'linux' || process.platform === 'darwin')) {
  console.warn(`[agent-workspace tests] sandboxed local shell tests are skipped: ${POSIX_SANDBOX.reason}`);
}
