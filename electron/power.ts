import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../host/platform/log/api.ts';
import { formatIoError } from './shell/errors.ts';

/** cmd/power.rs: one child, idempotent enable, lifetime tied to this process. */
export function createPowerGuard(platform: 'darwin' | 'linux' | 'win32', log: Pick<Logger, 'info' | 'warn'>) {
  let child: ChildProcess | null = null;
  let serial = Promise.resolve();
  const current = () => {
    if (child !== null && (child.exitCode !== null || child.signalCode !== null)) child = null;
    return child !== null;
  };
  const set = async (enabled: boolean): Promise<boolean> => {
    if (platform === 'win32') {
      if (enabled) log.warn('[power] prevent-sleep not supported on this platform');
      return false;
    }
    if (enabled) {
      if (current()) return true;
      const mac = platform === 'darwin';
      const command = mac ? 'caffeinate' : 'systemd-inhibit';
      const args = mac ? ['-i', '-w', String(process.pid)] : ['--what=sleep:idle', '--who=DeepStudent', '--why=Long-running card generation task', 'tail', `--pid=${process.pid}`, '-f', '/dev/null'];
      const next = spawn(command, args, { stdio: 'inherit' });
      try {
        await new Promise<void>((resolve, reject) => {
          next.once('spawn', resolve);
          next.once('error', (e) => reject(`failed to spawn ${command}: ${formatIoError(e, platform)}`));
        });
      } catch (error) {
        log.warn(`[power] failed to enable prevent-sleep: ${String(error)}`);
        throw error;
      }
      log.info(`[power] prevent-sleep enabled (pid=${next.pid})`);
      child = next;
      return true;
    }
    const previous = child;
    child = null;
    if (previous && previous.exitCode === null && previous.signalCode === null) {
      const exited = new Promise<void>((resolve) => previous.once('exit', () => resolve()));
      previous.kill('SIGKILL');
      await exited;
    }
    if (previous) log.info('[power] prevent-sleep disabled');
    return false;
  };
  return {
    get: current,
    set(enabled: boolean): Promise<boolean> {
      const result = serial.then(() => set(enabled));
      serial = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
