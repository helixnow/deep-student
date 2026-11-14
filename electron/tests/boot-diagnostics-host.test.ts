/** WP-199: real document events → production preload/main → official Host/logging/ACL. */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { spawnElectron } from './electron-process.ts';
import { buildPreload } from '../scripts/build-preload.mjs';

it('installs before the first script under unchanged CSP, reports real failures and 8000ms blank root, and hands off on reload', async () => {
  await buildPreload();
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/f2-boot-');
  const wirePath = join(root, 'wire.jsonl');
  const reporter = await build({ entryPoints: [resolve('src/logging/errorReporter.ts')], bundle: true,
    write: false, format: 'iife', globalName: 'Reporter', platform: 'browser', define: { 'import.meta.env.PROD': 'false' } });
  const csp = JSON.parse(readFileSync('resources/app/tauri.conf.json', 'utf8')).app.security.csp;
  const reports: any[] = [];
  const children: any[] = [];
  const requests: Array<{ url: string; at: number }> = [];
  const started = performance.now();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push({ url: request.url!, at: Math.round(performance.now() - started) });
    if (url.pathname === '/report') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const report = JSON.parse(body);
        (report.role ? children : reports).push(report);
        writeFileSync(join(root, 'reports.json'), JSON.stringify({ reports, children }));
        response.end('ok');
      });
      return;
    }
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('Content-Type', 'text/javascript');
    if (url.pathname === '/child-first.js') {
      response.end(`window.first = { role: new URL(location.href).searchParams.get('role'), cleanup: typeof window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__, at: performance.now(), timeOrigin: performance.timeOrigin };
        window.rejections = [];
        addEventListener('unhandledrejection', event => rejections.push(String(event.reason)));
        throw new Error(first.role + '-first-script');`);
      return;
    }
    if (url.pathname === '/child-runner.js') {
      response.end(`setTimeout(() => { throw new Error(first.role + '-after-main-cleanup'); }, 8100);
        (async () => {
          await new Promise(resolve => setTimeout(resolve, Math.max(0, 8400 - performance.now())));
          while (window.__TAURI_INTERNALS__.callbacks.size) {
            if (performance.now() > 40000) throw new Error('child diagnostic callbacks did not settle');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          await fetch('/report', { method: 'POST', body: JSON.stringify({ ...first, rejections, callbacks: window.__TAURI_INTERNALS__.callbacks.size, cleanupAfter: typeof window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__ }) });
        })().catch(error => fetch('/report', { method: 'POST', body: JSON.stringify({ role: first.role, fatal: String(error) }) }));`);
      return;
    }
    if (url.pathname === '/child') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><script src="/child-first.js"></script><script src="/child-runner.js"></script>
        ${url.searchParams.get('role') === 'assistant' ? '<div id="root"><span>started</span></div>' : ''}`);
      return;
    }
    if (url.pathname === '/first.js') {
      response.end(`${reporter.outputFiles[0]!.text}
        window.stage = Number(sessionStorage.getItem('stage') || 0);
        if (stage === 2) location.hash = '#reload';
        window.first = { stage, cleanup: typeof window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__, at: performance.now(), timeOrigin: performance.timeOrigin, ua: navigator.userAgent, url: location.href };
        if (stage === 1) {
          first.cleared = []; first.removed = [];
          const clear = window.clearTimeout, remove = window.removeEventListener;
          window.clearTimeout = id => { first.cleared.push(id); clear(id); };
          window.removeEventListener = function(name, listener, capture) { first.removed.push([name, capture]); remove.call(this, name, listener, capture); };
          Reporter.installGlobalErrorReporter();
          window.clearTimeout = clear; window.removeEventListener = remove;
          first.afterCleanup = typeof window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__;
        }
        throw new Error('first-script-' + stage);`);
    } else if (url.pathname === '/runner.js') {
      response.end(`Promise.reject(new Error('rejection-error-' + stage));
        Promise.reject('rejection-string-' + stage);
        (async () => {
          const status = await window.__TAURI_INTERNALS__.invoke('plugin:host|status');
          if (stage === 0) {
            await window.__TAURI_INTERNALS__.invoke('plugin:webview|create_webview_window', { options: { label: 'quick-assistant', url: location.origin + '/child?role=assistant', visible: false, focus: false } });
            await window.__TAURI_INTERNALS__.invoke('save_setting', { key: 'desktop.workbenchBrowserEnabled', value: 'true' });
            await window.__TAURI_INTERNALS__.invoke('browser_open_session', { url: location.origin + '/child?role=browser', fromAgent: false });
          }
          await new Promise(resolve => setTimeout(resolve, Math.max(0, 8300 - performance.now())));
          while (window.__TAURI_INTERNALS__.callbacks.size) {
            if (performance.now() > 40000) throw new Error('diagnostic callbacks did not settle');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          await fetch('/report', { method: 'POST', body: JSON.stringify({ ...first, status, elapsed: performance.now(), callbacks: window.__TAURI_INTERNALS__.callbacks.size }) });
          if (stage < 2) { sessionStorage.setItem('stage', String(stage + 1)); location.reload(); }
        })().catch(error => fetch('/report', { method: 'POST', body: JSON.stringify({ fatal: String(error) }) }));`);
    } else if (url.pathname === '/missing.js') { response.writeHead(404); response.end(''); }
    else if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); }
    else {
      response.setHeader('Content-Type', 'text/html');
      // External scripts are allowed by the ORIGINAL policy; the inline script must remain blocked.
      // The very first document script contains the original reporter module and then throws.
      response.end(`<!doctype html><script src="/first.js"></script>
        <script src="/runner.js"></script><script>window.inlineShouldNeverRun = true;</script>
        <script src="/missing.js"></script><div id="root"></div>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no local port');
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env };
  delete env.DS_HOST_PROFILE;
  const child = await spawnElectron(createRequire(import.meta.url)('electron') as string,
    [join(import.meta.dirname, 'fixtures/boot-diagnostics-main.ts')], { env: {
      ...env, ELECTRON_RUN_AS_NODE: '', DS_ELECTRON_DEV_URL: `${origin}/#boot`,
      DS_HOST_ENTRY: resolve('host/kernel/main.ts'), DS_APP_DATA_DIR: join(root, 'appdata'),
      DS_ELECTRON_USER_DATA: join(root, 'userdata'), HOME: root, XDG_DATA_HOME: join(root, 'data'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
      APPDATA: join(root, 'data'), LOCALAPPDATA: join(root, 'data'), USERPROFILE: root, BOOT_WIRE: wirePath,
    } });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  try {
    const deadline = performance.now() + 50_000;
    while ((reports.length < 3 || children.length < 2) && ![...reports, ...children].some(report => report.fatal)) {
      if (child.exitCode !== null || child.signalCode !== null || performance.now() >= deadline) {
        throw new Error(`incomplete boot reports (${root}): ${JSON.stringify({ reports, children, requests, exitCode: child.exitCode, signalCode: child.signalCode })}\n${output}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(reports.map(report => report.fatal), root).toEqual([undefined, undefined, undefined]);
    expect(children.map(report => report.fatal), root).toEqual([undefined, undefined]);
    expect(reports.map(report => report.cleanup), root).toEqual(['function', 'function', 'function']);
    expect(reports[1].afterCleanup).toBe('undefined');
    expect(reports[1].cleared).toEqual([expect.any(Number)]);
    expect(reports[1].removed).toEqual([['error', true], ['unhandledrejection', true], ['securitypolicyviolation', true]]);
    expect(reports.every(report => report.status.length === 0)).toBe(true);
    expect(reports.every(report => report.callbacks === 0)).toBe(true);
    const wire = readFileSync(wirePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const allCalls = wire.filter(row => row.direction === 'invoke' && row.message.cmd === 'report_frontend_log');
    const calls = allCalls.filter(row => new URL(row.url).pathname === '/index.html');
    const payloads = calls.map(row => JSON.parse(row.message.payload.data).payload);
    for (const stage of [0, 2]) {
      const errors = payloads.filter(p => p.kind === 'BOOT_WINDOW_ERROR' && p.message === `Uncaught Error: first-script-${stage}`);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ route: stage === 0 ? '/index.html' : '#reload', url: reports[stage].url, extra: null });
      expect(errors[0].stack).toContain(`Error: first-script-${stage}\n    at ${origin}/first.js:`);
      expect(payloads.filter(p => p.kind === 'BOOT_UNHANDLED_REJECTION' && p.message === `rejection-error-${stage}`)).toHaveLength(1);
      expect(payloads.filter(p => p.kind === 'BOOT_UNHANDLED_REJECTION' && p.message === `rejection-string-${stage}`)).toHaveLength(1);
    }
    expect(payloads.filter(p => p.kind === 'BOOT_RESOURCE_ERROR')).toHaveLength(2);
    expect(payloads.filter(p => p.kind === 'BOOT_CSP_VIOLATION')).toHaveLength(2);
    expect(payloads.filter(p => p.kind === 'BOOT_BLANK_SCREEN')).toHaveLength(2);
    expect(payloads.filter(p => p.kind.startsWith('BOOT_') && p.message.includes('-1'))).toEqual([]);
    expect(payloads.some(p => p.kind === 'WINDOW_ERROR' && p.message.includes('first-script-1'))).toBe(true);
    for (const p of payloads.filter(p => p.kind.startsWith('BOOT_'))) {
      expect(Object.keys(p).sort()).toEqual(['extra', 'kind', 'level', 'message', 'route', 'stack', 'url', 'user_agent']);
      expect(p).toMatchObject({ level: 'ERROR', user_agent: reports[0].ua });
    }
    expect(payloads.filter(p => p.kind === 'BOOT_CSP_VIOLATION').map(p => p.message)).toEqual([
      'CSP blocked inline via script-src-elem', 'CSP blocked inline via script-src-elem']);
    expect(payloads.filter(p => p.kind === 'BOOT_RESOURCE_ERROR').map(p => p.extra)).toEqual([
      { resource: `${origin}/missing.js` }, { resource: `${origin}/missing.js` }]);
    const blanks = calls.filter(row => JSON.parse(row.message.payload.data).payload.kind === 'BOOT_BLANK_SCREEN');
    expect(blanks[0].at - reports[0].timeOrigin).toBeGreaterThanOrEqual(8000);
    expect(blanks[1].at - reports[2].timeOrigin).toBeGreaterThanOrEqual(8000);
    for (const call of calls) {
      const reply = wire.find(row => row.direction === 'reply' && row.contents === call.contents && row.message.callbackId === call.message.callback);
      expect(reply, root).toBeDefined();
      expect(reply.message.body).toEqual({ kind: 'json', data: 'null' });
    }
    // DS_APP_DATA_DIR 隔离：Host 的 home / data_local_dir 来自外壳的 DS_SHELL_OS_DIRS（<appdata>.os/home），不是 HOME/XDG_*。
    const isolatedHome = join(root, 'appdata.os', 'home');
    const logDir = process.platform === 'darwin' ? join(isolatedHome, 'Library/Logs/com.deepstudent.app/frontend')
      : process.platform === 'win32' ? join(isolatedHome, 'AppData/Local/com.deepstudent.app/logs/frontend')
        : join(isolatedHome, '.local/share/com.deepstudent.app/logs/frontend');
    expect(existsSync(logDir), root).toBe(true);
    const logs = readdirSync(logDir).flatMap(file => readFileSync(join(logDir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    expect(logs.filter(row => row.operation.startsWith('BOOT_') && row.data.url === `${origin}/index.html`)).toHaveLength(12);
    expect(logs.filter(row => row.operation.startsWith('BOOT_'))).toHaveLength(14);
    expect(logs.find(row => row.operation === 'BOOT_WINDOW_ERROR')).toMatchObject({ level: 'ERROR', module: 'FRONTEND', data: { message: 'Uncaught Error: first-script-0', url: `${origin}/index.html` } });
    expect(children.map(row => row.role).sort()).toEqual(['assistant', 'browser']);
    for (const row of children) {
      expect(row).toMatchObject({ cleanup: 'function', cleanupAfter: 'function', callbacks: 0, rejections: [] });
      const childCalls = allCalls.filter(call => new URL(call.url).searchParams.get('role') === row.role);
      const childPayloads = childCalls.map(call => JSON.parse(call.message.payload.data).payload);
      expect(childPayloads.filter(p => p.kind === 'BOOT_WINDOW_ERROR').map(p => p.message)).toEqual([
        `Uncaught Error: ${row.role}-first-script`, `Uncaught Error: ${row.role}-after-main-cleanup`]);
      // Populated root does not report; missing root in browser-content does attempt the same timer.
      expect(childPayloads.filter(p => p.kind === 'BOOT_BLANK_SCREEN')).toHaveLength(row.role === 'browser' ? 1 : 0);
      for (const call of childCalls) {
        const denied = row.role === 'browser';
        const reply = wire.find(item => item.direction === 'reply' && item.contents === call.contents
          && item.message.callbackId === (denied ? call.message.error : call.message.callback));
        expect(reply, root).toBeDefined();
        const result = JSON.parse(reply.message.body.data);
        if (denied) expect(result).toContain(`report_frontend_log not allowed on window "${process.platform === 'linux' ? 'browser-content' : 'main'}", webview "browser-content"`);
        else expect(result).toBeNull();
      }
    }
    expect(logs.filter(row => row.data?.message?.includes('assistant-'))).toHaveLength(2);
    expect(logs.filter(row => row.data?.message?.includes('browser-'))).toEqual([]);
  } finally {
    writeFileSync(join(root, 'electron.log'), output);
    writeFileSync(join(root, 'progress.json'), JSON.stringify({ reports, children, requests }, null, 2));
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 60_000);
