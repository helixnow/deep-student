import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { canReuseDevServer } from './tauri-dev-server.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test('reuses an existing Vite-style HTML dev server', async () => {
  await withServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/@vite/client"></script></body></html>');
  }, async (url) => {
    assert.equal(await canReuseDevServer(url), true);
  });
});

test('does not reuse a non-matching server response', async () => {
  await withServer((_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  }, async (url) => {
    assert.equal(await canReuseDevServer(url), false);
  });
});
