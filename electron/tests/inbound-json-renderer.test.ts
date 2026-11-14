/** Production preload → ShellRuntime → HostSupervisor/MessagePort → real kernel and review handler. */
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { spawnElectron } from './electron-process.ts';
import { buildPreload } from '../scripts/build-preload.mjs';

it('WP-134 preserves 993/992 in actual insight_list calls, contracts, source/ACL, objects, errors and bytes', async () => {
  await buildPreload();
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/f2-inbound-');
  const contracts = join(root, 'contracts');
  mkdirSync(contracts);
  copyFileSync(join(import.meta.dirname, '../../contracts/ipc/L15-review-analytics.json'), join(contracts, 'review.json'));
  writeFileSync(join(contracts, 'fixture.json'), JSON.stringify({
    lane: 'fixture', generator: 'fixture', $defs: {}, events: [],
    commands: ['inbound_echo', 'inbound_error', 'inbound_bytes', 'inbound_denied'].map(name => ({
      name, args: name === 'inbound_echo' ? [{ key: 'value', rustName: 'value', optional: false, schema: { 'x-rust': 'serde_json::Value' } }] : [],
      result: name === 'inbound_bytes' ? { 'x-binary': true } : true, error: true,
    })),
  }));
  const calls = join(root, 'calls.jsonl');
  const profile = join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ plugins: [
    { id: 'fixture.inbound-json', module: join(import.meta.dirname, '__fixtures__/inbound-json-plugin.ts') },
    { id: 'dstu.review', module: join(import.meta.dirname, '../../host/plugins/review/index.ts') },
  ] }));
  const reports: Record<string, unknown> = {};
  const remote = createServer();
  // Both origins report locally; only their origin differs, not their preload/command path.
  const receive = (name: string, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { reports[name] = JSON.parse(body); response.end('ok'); });
  };
  remote.on('request', (request, response) => {
    if (request.method === 'POST') { receive('remote', request, response); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><script>
      (async () => {
        let result;
        try { result = { unexpected: await window.__TAURI_INTERNALS__.invoke('insight_list', { offset: JSON.rawJSON('9007199254740993'), limit: 1 }) }; }
        catch (error) { result = { error }; }
        await fetch('/report', { method: 'POST', body: JSON.stringify(result) });
      })();
    </script>`);
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const remoteAddress = remote.address();
  if (!remoteAddress || typeof remoteAddress === 'string') throw new Error('no remote port');
  const html = `<!doctype html><script>
    (async () => {
      const ipc = window.__TAURI_INTERNALS__;
      const result = { lists: [], invalid: [] };
      const source = text => JSON.parse(text, (_key, value, context) => typeof value === 'number' ? JSON.rawJSON(context.source) : value);
      for (const text of ['{"offset":9007199254740993,"limit":1,"status":null}', '{"offset":9007199254740992,"limit":1}']) {
        result.lists.push(await ipc.invoke('insight_list', source(text)));
      }
      result.lists.push(await ipc.invoke('insight_list', { offset: 3, limit: 2, status: 'active' }));
      result.lists.push(await ipc.invoke('insight_list', { offset: null, limit: null }));
      for (const text of ['{"offset":9223372036854775808}', '{"offset":1.0}', '{"offset":1e0}', '{"offset":"9007199254740993"}', '{"offset":false,"limit":"bad","status":42}']) {
        try { result.invalid.push({ unexpected: await ipc.invoke('insight_list', source(text)) }); }
        catch (error) { result.invalid.push(error); }
      }
      result.echo = await ipc.invoke('inbound_echo', { value: { n: 7, array: [true, null, 'x'], rawJSON: '9007199254740993' }, extra: 'kept in payload' }, { headers: { 'X-Probe': 'original' } });
      result.bytes = Array.from(new Uint8Array(await ipc.invoke('inbound_bytes', new Uint8Array([0, 127, 255]))));
      for (const command of ['inbound_error', 'inbound_denied', 'inbound_missing']) {
        try { result[command] = { unexpected: await ipc.invoke(command) }; }
        catch (error) { result[command] = error; }
      }
      for (let i = 0; i < 50 && ipc.callbacks.size > 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      result.callbacks = ipc.callbacks.size;
      await fetch('/report', { method: 'POST', body: JSON.stringify(result) });
      location.href = 'http://127.0.0.1:${remoteAddress.port}/';
    })().catch(error => fetch('/report', { method: 'POST', body: JSON.stringify({ fatal: String(error) }) }));
  </script>`;
  const server = createServer((request, response) => {
    if (request.method === 'POST') { receive('local', request, response); return; }
    response.setHeader('Content-Type', 'text/html'); response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no local port');
  // 主窗口的渲染端跨 origin 导航会被安全策略拦下；该入口随后以 loadURL 程序化加载远程页，ACL 断言不变。
  const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, 'fixtures/programmatic-remote-main.ts')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
      DS_HOST_ENTRY: join(import.meta.dirname, '__fixtures__/inbound-json-host.ts'), DS_HOST_PROFILE: profile,
      DS_APP_DATA_DIR: join(root, 'appdata'), DS_ELECTRON_USER_DATA: join(root, 'userdata'),
      INBOUND_CONTRACTS: contracts, INBOUND_CALLS: calls },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  try {
    const deadline = performance.now() + 25_000;
    while (reports.remote === undefined) {
      if (child.exitCode !== null || performance.now() >= deadline) throw new Error(`no renderer report: ${JSON.stringify(reports)} ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
      [null, 1, { type: 'bigint', decimal: '9007199254740993' }],
      [null, 1, { type: 'bigint', decimal: '9007199254740992' }],
      ['active', 2, 3], [null, 100, 0],
    ]);
    const value = { n: 7, array: [true, null, 'x'], rawJSON: '9007199254740993' };
    expect(reports.local, output).toEqual({
      lists: [[], [], [], []],
      invalid: [
        'invalid args `offset` for command `insight_list`: invalid number',
        'invalid args `offset` for command `insight_list`: invalid number',
        'invalid args `offset` for command `insight_list`: invalid number',
        'invalid args `offset` for command `insight_list`: invalid type: string "9007199254740993", expected i64',
        'invalid args `status` for command `insight_list`: invalid type: number, expected a string',
      ],
      echo: { args: { value }, payload: { value, extra: 'kept in payload' }, source: { window: 'main', webview: 'main' }, headers: { 'x-probe': 'original' } },
      bytes: [0, 127, 255], inbound_error: { error_type: 'Validation', message: 'inbound failure', details: null },
      inbound_denied: expect.stringContaining('not allowed'), inbound_missing: expect.stringContaining('not allowed'), callbacks: 0,
    });
    expect(reports.remote).toEqual({ error: expect.stringContaining('not allowed') });
    expect(output).toContain(`[security] app: blocked navigate to http://127.0.0.1:${remoteAddress.port}`);
  } finally {
    child.kill('SIGKILL');
    for (const http of [server, remote]) {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    }
  }
}, 40_000);
