import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// A self-driving devUrl page avoids adding a WebDriver dependency or altering
// Rust. One pending command, one webview; no 8-instance pool in WP-043.
export async function startHarnessServer(port = 1422) {
  const ready = Promise.withResolvers();
  let receiver, command, pending;
  const evidence = { wire: [], events: [], failures: [], ready: null };
  const send = () => {
    if (receiver && command) {
      receiver.setHeader('content-type', 'application/json');
      receiver.end(JSON.stringify(command));
      receiver = command = null;
    }
  };
  const fail = error => { ready.reject(error); pending?.reject(error); };
  const server = createServer(async (request, response) => {
    try {
      const path = request.url;
      if (request.method === 'GET' && ['/', '/tauri-harness.mjs'].includes(path)) {
        response.setHeader('content-type', path === '/' ? 'text/html' : 'text/javascript');
        response.end(await readFile(new URL(path === '/' ? './tauri-harness.html' : './tauri-harness.mjs', import.meta.url)));
      } else if (request.method === 'GET' && path === '/next') {
        if (receiver) throw new Error('duplicate harness poll');
        receiver = response; send();
      } else if (request.method === 'POST') {
        request.setEncoding('utf8');
        let text = '';
        for await (const chunk of request) text += chunk;
        const body = JSON.parse(text); // envelope only; raw IPC JSON stays a string
        if (path === '/ready') { evidence.ready = body; ready.resolve(body); }
        else if (path === '/outcome') {
          if (!pending) throw new Error('unexpected outcome');
          evidence.wire.push(...body.wire); evidence.events = body.events;
          pending.resolve(body); pending = null;
        } else if (path === '/closing') { evidence.closing = body; }
        else if (path === '/failure') { evidence.failures.push(body); fail(new Error(body.message)); }
        else throw new Error(`unknown route ${path}`);
        response.end('ok');
      } else { response.statusCode = 404; response.end(); }
    } catch (error) { fail(error); response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    evidence, ready: ready.promise, url: `http://127.0.0.1:${server.address().port}`,
    invoke(name, argsRaw) {
      if (pending || command) throw new Error('concurrent harness command');
      pending = Promise.withResolvers();
      const promise = pending.promise;
      command = { command: name, argsRaw }; send();
      return promise;
    },
    requestExit() { command = { close: true }; send(); },
    abort: fail,
    async close() {
      if (receiver) { receiver.end('{"close":true}'); receiver = null; }
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
