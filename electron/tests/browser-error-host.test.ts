/** WP-194: actual page bridge → BrowserContentSurface → main/HostSupervisor → MessagePort → public ShellError. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { spawnElectron } from './electron-process.ts';
import { buildPreload } from '../scripts/build-preload.mjs';

it('PASSWORD_INPUT_BLOCKED scenario preserves the real BLOCKED body, Option details, display, source and failure settle', async () => {
  await buildPreload();
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/f2-browser-error-');
  const contracts = join(root, 'contracts');
  mkdirSync(contracts);
  writeFileSync(join(contracts, 'fixture.json'), JSON.stringify({
    lane: 'fixture', generator: 'fixture', $defs: {}, events: [], commands: [{
      name: 'browser_error_probe', args: [
        { key: 'op', rustName: 'op', optional: false, schema: { type: 'string' } },
        { key: 'args', rustName: 'args', optional: false, schema: { 'x-rust': 'serde_json::Value' } },
      ], result: true, error: true,
    }],
  }));
  const profile = join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ plugins: [
    { id: 'fixture.browser-error', module: join(import.meta.dirname, '__fixtures__/browser-error-plugin.ts') },
  ] }));
  // The unchanged production script creates the password error from an actual DOM input.
  const bridge = readFileSync(join(import.meta.dirname, '../../host/plugins/browser/src/browser-bridge.js'), 'utf8');
  const wirePath = join(root, 'wire.jsonl');
  let report: Record<string, any> | undefined;
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { writeFileSync(join(root, 'report.json'), body); report = JSON.parse(body); response.end('ok'); });
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url?.startsWith('/content')) {
      // Additional envelope inputs exercise Option<Value>; only these variants wrap the real bridge result.
      const mode = new URL(request.url, 'http://localhost').searchParams.get('mode');
      const details = mode === 'null' ? 'null' : '{ nested: [null, false, 0, "原样", { retry: false }] }';
      response.end(`<!doctype html><title>Bridge error page</title>
        <input type="password" aria-label="secret"><input type="text" aria-label="plain">
        <script>${bridge}</script>
        ${mode === 'null' || mode === 'nested' ? `<script>
          const original = window.__dsBrowserBridge.type;
          window.__dsBrowserBridge.type = (...args) => { const result = original(...args); result.error.details = ${details}; return result; };
        </script>` : ''}`);
      return;
    }
    response.end(`<!doctype html><script>
      (async () => {
        const ipc = window.__TAURI_INTERNALS__;
        const call = (op, args = {}) => ipc.invoke('browser_error_probe', { op, args });
        const failure = async (op, args) => { try { return { unexpected: await call(op, args) }; } catch (error) { return error; } };
        const result = {};
        result.ordinary = await failure('browser.snapshot', { interactiveOnly: true });
        for (const mode of ['original', 'null', 'nested']) {
          await call('browser.createContentWindow', { url: location.origin + '/content?mode=' + mode,
            title: 'WP-194', width: 800, height: 600, focused: false,
            profileDir: ${JSON.stringify(join(root, 'browser-profile'))}, initializationScript: '' });
          // macOS/Windows 的内嵌视图创建时是 1×1 且隐藏（与 Rust 一致），要像 surface host 一样给出 bounds 并显示；
          // Linux detached 窗口上这两个 op 分别为 no-op 与 show。
          await call('browser.setContentBounds', { x: 0, y: 0, width: 800, height: 600 });
          await call('browser.setContentVisibility', { visible: true, focus: false });
          let snapshot;
          const deadline = performance.now() + 10000;
          while (true) {
            try { snapshot = await call('browser.snapshot', { interactiveOnly: true }); if (snapshot.count === 2) break; }
            catch (error) { if (performance.now() >= deadline) throw error; }
            if (performance.now() >= deadline) throw new Error('content not ready');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          const password = snapshot.nodes.find(node => node.password);
          const plain = snapshot.nodes.find(node => !node.password);
          result[mode] = await failure('browser.typeText', { ref: password.ref, text: 'must not be written' });
          if (mode === 'original') {
            result.snapshot = { count: snapshot.count, engine: snapshot.engine, passwordRef: password.ref, plainRef: plain.ref };
            result.omitted = await failure('browser.click', { ref: 'missing' });
            result.success = await call('browser.typeText', { ref: plain.ref, text: 'hello 原样' });
            result.after = (await call('browser.snapshot', { interactiveOnly: true })).nodes.map(node => ({ password: node.password, value: node.value }));
          }
          await call('browser.destroyContentWindow');
        }
        result.callbacks = ipc.callbacks.size;
        await fetch('/report', { method: 'POST', body: JSON.stringify(result) });
      })().catch(error => fetch('/report', { method: 'POST', body: JSON.stringify({ fatal: error }) }));
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no local port');
  const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, '../main.ts')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
      DS_HOST_ENTRY: join(import.meta.dirname, '__fixtures__/browser-error-host.ts'), DS_HOST_PROFILE: profile,
      DS_APP_DATA_DIR: join(root, 'appdata'), DS_ELECTRON_USER_DATA: join(root, 'userdata'),
      BROWSER_ERROR_CONTRACTS: contracts, BROWSER_ERROR_WIRE: wirePath },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  try {
    const deadline = performance.now() + 25_000;
    while (!report) {
      if (child.exitCode !== null || performance.now() >= deadline) throw new Error(`no browser error report (${root}): ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(report.fatal, `${root}\n${output}`).toBeUndefined();
    const source = { window: 'main', webview: 'main' };
    const message = 'password fields cannot be typed by agent bridge';
    const blocked = (data: unknown) => ({ publicShellError: true, name: 'ShellError', op: 'browser.typeText',
      message: `bridge error BLOCKED: ${message}`, display: `ShellError: bridge error BLOCKED: ${message}`, source, data });
    expect(report.original).toEqual(blocked({ code: 'BLOCKED', message, details: { reason: 'password_field', ref: report.snapshot.passwordRef } }));
    expect(report.null).toEqual(blocked({ code: 'BLOCKED', message }));
    expect(report.nested).toEqual(blocked({ code: 'BLOCKED', message, details: { nested: [null, false, 0, '原样', { retry: false }] } }));
    expect(report.omitted).toEqual({ publicShellError: true, name: 'ShellError', op: 'browser.click',
      message: 'bridge error STALE_REF: ref not found or detached: missing',
      display: 'ShellError: bridge error STALE_REF: ref not found or detached: missing', source,
      data: { code: 'STALE_REF', message: 'ref not found or detached: missing' } });
    expect(report.ordinary).toEqual({ publicShellError: true, name: 'ShellError', op: 'browser.snapshot',
      message: 'webview not found: browser-content', display: 'ShellError: webview not found: browser-content', source });
    expect(report.snapshot).toMatchObject({ count: 2, engine: 'ax-lite' });
    expect(report.success).toEqual({ ref: report.snapshot.plainRef, valuePreview: 'hello 原样' });
    expect(report.after).toEqual([{ password: true, value: '[password]' }, { value: 'hello 原样' }]);
    expect(report.callbacks).toBe(0);
    const wire = readFileSync(wirePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const blockedWire = wire.filter(item => item.kind === 'shell-result' && item.error === `bridge error BLOCKED: ${message}`);
    expect(blockedWire.map(item => item.errorData)).toEqual([report.original.data, report.null.data, report.nested.data]);
    const ordinary = wire.find(item => item.kind === 'shell-result' && item.error === 'webview not found: browser-content');
    expect(ordinary).not.toHaveProperty('errorData');
    expect(blockedWire.every(item => item.ok === false)).toBe(true);
    const settled = wire.filter(item => item.kind === 'settled');
    expect(settled.filter(item => item.ok === false).length).toBeGreaterThanOrEqual(5);
    expect(settled.every(item => item.pending === 0)).toBe(true);
    expect(new Set(settled.map(item => item.id)).size).toBe(settled.length);
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 40_000);
