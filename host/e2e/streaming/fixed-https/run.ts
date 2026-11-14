/** node run.ts -- <binary> <args...>; one independent service and directory per invocation. */
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startIlinkService } from './service.ts';

export async function runIsolated(command: string, args: string[], parent = '/tmp/opencode') {
  const service = await startIlinkService(parent);
  const child = spawn(command, args, { env: service.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const forward = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  };
  const onTerm = () => forward('SIGTERM');
  const onInt = () => forward('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  child.stdout.on('data', data => appendFileSync(join(service.dir, 'child.stdout'), data));
  child.stderr.on('data', data => appendFileSync(join(service.dir, 'child.stderr'), data));
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
      // Announce only after signal/error/exit handlers exist; the parent may stop us immediately.
      process.stdout.write(JSON.stringify({ ready: true, dir: service.dir, proxy: service.proxyUrl }) + '\n');
    });
    // A successful process with no HTTPS requests is not evidence of proxy/trust wiring.
    const ok = result.code === 0 && service.requests.length > 0 && service.faults.length === 0;
    writeFileSync(join(service.dir, 'result.json'), JSON.stringify({ ...result, ok, requests: service.requests.length,
      faults: service.faults, evidence: 'transport only; not A/B parity or login golden' }, null, 2));
    return { dir: service.dir, ok, ...result };
  } catch (error) {
    writeFileSync(join(service.dir, 'result.json'), JSON.stringify({ ok: false, error: String(error) }));
    throw error;
  } finally {
    forward('SIGTERM');
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    await service.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [separator, command, ...args] = process.argv.slice(2);
  if (separator !== '--' || !command) throw new Error('usage: node run.ts -- <binary> <args...>');
  try {
    const result = await runIsolated(command, args);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : result.code || 1;
  } catch (error) {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  }
}
