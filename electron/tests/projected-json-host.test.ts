/** Real Electron main/preload and structured-clone Host protocol; not the F1 raw-atom producer. */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { spawnElectron } from './electron-process.ts';
import { buildPreload } from '../scripts/build-preload.mjs';

it('ordinary Host numbers normalize while finite values and rawJSON-shaped objects reach renderer unchanged', async () => {
  await buildPreload();
  const root = mkdtempSync(join(tmpdir(), 'f2-projected-json-'));
  let report: unknown;
  const html = `<!doctype html><script>
    (async () => {
      const internal = window.__TAURI_INTERNALS__;
      const inspect = value => ({
        numbers: value.numbers.map(n => ({ positiveInfinity: n === Infinity, negativeInfinity: n === -Infinity, negativeZero: Object.is(n, -0), finite: Number.isFinite(n) })),
        values: value.numbers,
        ordinary: value.ordinary
      });
      const result = {};
      let done;
      const event = new Promise(resolve => { done = resolve; });
      await internal.invoke('plugin:event|listen', { event: 'projected://numbers', target: { kind: 'Any' }, handler: internal.transformCallback(e => { result.event = inspect(e.payload); done(); }) });
      result.invoke = inspect(await internal.invoke('projected_probe'));
      await event;
      await fetch('/report', { method: 'POST', body: JSON.stringify(result) });
    })().catch(error => fetch('/report', { method: 'POST', body: JSON.stringify({ error: String(error) }) }));
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
      DS_HOST_ENTRY: join(import.meta.dirname, 'fixtures/projected-json-host.ts'),
      DS_APP_DATA_DIR: join(root, 'appdata'), DS_ELECTRON_USER_DATA: join(root, 'userdata'),
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
    const expected = {
      numbers: [
        { positiveInfinity: false, negativeInfinity: false, negativeZero: false, finite: false },
        { positiveInfinity: false, negativeInfinity: false, negativeZero: false, finite: false },
        ...[0, 1, 2, 3].map(() => ({ positiveInfinity: false, negativeInfinity: false, negativeZero: false, finite: true })),
      ], values: [null, null, 0, 0, 0, 1.5], ordinary: { rawJSON: '1e400' },
    };
    expect(report, output).toEqual({ invoke: expected, event: expected });
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 40_000);
