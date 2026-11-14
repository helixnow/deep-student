/** Actual main + official Host/profile/ACL; only the final process hooks are replaced. */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';
import { buildInfo } from '../build-info.ts';
import packageJson from '../../package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));

it('actual Host commands return full version and reach both restart aliases and main PDF allowed dirs', async () => {
  await buildPreload();
  const info = buildInfo(resolve(here, '../..'), packageJson.version);
  const root = mkdtempSync(join(tmpdir(), 'dstu-real-shell-'));
  const data = join(root, 'appdata');
  mkdirSync(data);
  const pdf = join(data, 'allowed.PDF');
  const hooksPath = join(root, 'hooks.jsonl');
  let report: Record<string, unknown> | undefined;
  const html = `<!doctype html><meta charset="utf-8"><script>
    (async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const report = {};
      async function call(key, command, args = {}) {
        try { report[key] = { ok: true, value: await invoke(command, args) }; }
        catch (error) { report[key] = { ok: false, error }; }
      }
      await call('status', 'plugin:host|status');
      await call('version', 'get_app_version');
      // F3 relocates legacy root files during boot; seed only after HostReady.
      await fetch('/seed', { method: 'POST' });
      await call('restart', 'restart_app');
      await call('pdf', 'pdfstream_check_access', { path: ${JSON.stringify(pdf)} });
      await call('fileEmpty', 'filestream_check_access', { path: '' });
      await call('fileAllowed', 'filestream_check_access', { path: ${JSON.stringify(pdf)} });
      await call('purge', 'data_governance_purge_all_data');
      await fetch('/report', { method: 'POST', body: JSON.stringify(report) });
    })();
  </script>`;
  const server = createServer((request, response) => {
    if (request.url === '/seed' && request.method === 'POST') {
      writeFileSync(pdf, 'pdf probe');
      response.end('ok');
    } else if (request.url === '/report' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => { report = JSON.parse(body) as Record<string, unknown>; response.end('ok'); });
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(html);
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const env = { ...process.env };
  // Do not inherit another harness's Host/profile or a real user's filesystem roots.
  delete env.DS_HOST_PROFILE;
  const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(here, 'fixtures/restart-main.ts')], {
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '',
      DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
      DS_HOST_ENTRY: resolve(here, '../../host/kernel/main.ts'),
      DS_APP_DATA_DIR: data,
      DS_ELECTRON_USER_DATA: join(root, 'userdata'),
      HOME: root,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'),
      RESTART_HOOKS_REPORT: hooksPath,
    },
    stdio: 'pipe',
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  try {
    const deadline = performance.now() + 50_000;
    while (report === undefined) {
      if (spawnError || child.exitCode !== null || performance.now() > deadline) {
        throw new Error(`actual Host produced no report (${spawnError?.message ?? child.exitCode}); artifacts ${root}\n${output}`);
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    // Keep startup/ACL errors in the failure output rather than accepting degraded startup as success.
    const diagnostics = `artifacts ${root}\n${JSON.stringify(report)}\n${output}`;
    expect(report.status, diagnostics).toEqual({ ok: true, value: [] });
    expect(report.version, diagnostics).toEqual({ ok: true, value: `${info.version} (Build ${info.buildNumber}, ${info.gitHash})` });
    expect(report.restart, diagnostics).toEqual({ ok: true, value: null });
    expect(report.pdf, diagnostics).toEqual({ ok: true, value: { available: true, size: 9, reason: null } });
    expect(report.fileEmpty, diagnostics).toEqual({ ok: true, value: false });
    expect(report.fileAllowed, diagnostics).toEqual({ ok: true, value: true });
    expect(report.purge, diagnostics).toEqual({ ok: false, error: '应用重启未生效：进程仍在运行' });
    expect(readFileSync(join(data, '.purge_on_next_start'), 'utf8')).toBe('1');
    expect(existsSync(hooksPath), diagnostics).toBe(true);
    const hooks = readFileSync(hooksPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(hooks, diagnostics).toEqual([{ hook: 'restart' }, { hook: 'restart' }]);
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
}, 60_000);
