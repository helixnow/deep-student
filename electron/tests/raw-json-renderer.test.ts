/** Real Host kernel/plugin -> MessagePort -> Electron main -> preload -> renderer.
 * Release-mode typed Infinity must stay null even beside branded raw numeric atoms. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { spawnElectron } from './electron-process.ts';
import { buildPreload } from '../scripts/build-preload.mjs';

it('raw source text keeps mixed raw/typed success, error and targeted events through renderer parse', async () => {
  await buildPreload();
  const root = mkdtempSync(join(tmpdir(), 'f2-raw-renderer-'));
  const contracts = join(root, 'contracts');
  mkdirSync(contracts);
  writeFileSync(join(contracts, 'fixture.json'), JSON.stringify({
    lane: 'fixture', generator: 'fixture', $defs: {}, events: [],
    commands: ['raw_json_success', 'raw_json_error', 'raw_json_binary', 'raw_json_ordinary'].map(name => ({
      name, args: [], result: name === 'raw_json_binary' ? { 'x-binary': true } : true, error: true,
    })),
  }));
  const profile = join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ plugins: [{ id: 'fixture.raw-json', module: join(import.meta.dirname, '__fixtures__/raw-json-plugin.ts') }] }));
  let report: unknown;
  const html = `<!doctype html><script>
    (async () => {
      const ipc = window.__TAURI_INTERNALS__;
      const inspect = value => ({
        positive: value.raw[0] === Infinity, negative: value.raw[1] === -Infinity,
        underflow: Object.is(value.raw[2], -0), valueMinusZero: Object.is(value.raw[3], 0),
        large: value.raw[4] === 9007199254740992, fraction: value.raw[5] === 1.5,
        rawNegativeZero: Object.is(value.raw[6], -0),
        typed: value.typed, typedNegativeZero: Object.is(value.typed[3], -0), lookalike: value.lookalike
      });
      const result = {};
      let receivedRaw, receivedOrdinary;
      const rawEvent = new Promise(resolve => { receivedRaw = resolve; });
      const ordinaryEvent = new Promise(resolve => { receivedOrdinary = resolve; });
      await ipc.invoke('plugin:event|listen', { event: 'raw-source://value', target: { kind: 'WebviewWindow', label: 'main' }, handler: ipc.transformCallback(e => { result.event = inspect(e.payload); receivedRaw(); }) });
      await ipc.invoke('plugin:event|listen', { event: 'raw-source://ordinary', target: { kind: 'Any' }, handler: ipc.transformCallback(e => { result.ordinaryEvent = e.payload; receivedOrdinary(); }) });
      result.success = inspect(await ipc.invoke('raw_json_success'));
      try { await ipc.invoke('raw_json_error'); result.unexpectedSuccess = true; }
      catch (error) { result.error = inspect(error); }
      result.binary = Array.from(new Uint8Array(await ipc.invoke('raw_json_binary')));
      result.ordinary = await ipc.invoke('raw_json_ordinary');
      await Promise.all([rawEvent, ordinaryEvent]);
      await fetch('/report', { method: 'POST', body: JSON.stringify(result) });
    })().catch(error => fetch('/report', { method: 'POST', body: JSON.stringify({ fatal: String(error) }) }));
  </script>`;
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { report = JSON.parse(body); response.end('ok'); });
    } else { response.setHeader('Content-Type', 'text/html'); response.end(html); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, '../main.ts')], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '', DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
      DS_HOST_ENTRY: join(import.meta.dirname, 'fixtures/raw-json-host.ts'), DS_HOST_PROFILE: profile,
      DS_APP_DATA_DIR: join(root, 'appdata'), DS_ELECTRON_USER_DATA: join(root, 'userdata'), RAW_JSON_CONTRACTS: contracts,
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  try {
    const deadline = performance.now() + 25_000;
    while (report === undefined) {
      if (child.exitCode !== null || performance.now() >= deadline) throw new Error(`no renderer report: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const typed = [null, null, null, 0, 0, 1.5];
    const lookalike = { rawJSON: '1e400' };
    const expected = { positive: true, negative: true, underflow: true, valueMinusZero: true, large: true, fraction: true, rawNegativeZero: true, typed, typedNegativeZero: false, lookalike };
    expect(report, output).toEqual({ success: expected, error: expected, event: expected, binary: [0, 127, 255], ordinary: { typed, lookalike }, ordinaryEvent: { typed, lookalike } });
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 40_000);
