/** Linux GUI tests must not depend on the fulltest runner wrapping the whole suite in xvfb-run. */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

type Options = Omit<SpawnOptionsWithoutStdio, 'stdio'> & { stdio?: 'pipe' | ['ignore', 'pipe', 'pipe'] };

/** Starts a real Electron process; only the test display is supplied when Linux has no DISPLAY.
 * Electron remains the returned child, so existing kill/exit cleanup still targets the real process. */
export async function spawnElectron(executable: string, args: string[], options: Options): Promise<ChildProcessWithoutNullStreams> {
  const env = { ...(options.env ?? process.env) };
  let stopDisplay = () => undefined as void;
  if (process.platform === 'linux' && !env.DISPLAY) {
    const server = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp', '-ac'], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    server.stdout?.on('data', (data) => { diagnostics += String(data); });
    server.stderr?.on('data', (data) => { diagnostics += String(data); });
    stopDisplay = () => { if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); };
    process.once('exit', stopDisplay);
    try {
      env.DISPLAY = await new Promise<string>((resolve, reject) => {
        let display = '';
        const timer = setTimeout(() => reject(new Error(`Xvfb startup timed out: ${diagnostics}`)), 10_000);
        const clear = () => clearTimeout(timer);
        server.once('error', (error) => { clear(); reject(new Error(`cannot start Xvfb for Electron tests: ${error.message}`)); });
        server.once('exit', (code) => { clear(); reject(new Error(`Xvfb exited before display readiness (${code}): ${diagnostics}`)); });
        server.stdio[3]!.on('data', (data) => {
          display += String(data);
          if (!display.includes('\n')) return;
          clear();
          const number = display.trim();
          if (!/^\d+$/.test(number)) reject(new Error(`invalid Xvfb display number: ${display}`));
          else resolve(`:${number}`);
        });
      });
    } catch (error) {
      stopDisplay();
      process.off('exit', stopDisplay);
      throw error;
    }
  }
  const cleanup = () => { stopDisplay(); process.off('exit', stopDisplay); };
  const child = spawn(executable, args, { ...options, env, stdio: 'pipe' });
  child.once('exit', cleanup);
  child.once('error', cleanup);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}
