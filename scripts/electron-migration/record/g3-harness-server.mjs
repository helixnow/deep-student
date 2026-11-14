import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PAGE = '<!doctype html><html lang="en"><meta charset="utf-8"><title>X7 G3 recorder</title>'
  + '<div id="root">X7 G3 isolated command harness</div><script type="module" src="/g3-harness.mjs"></script></html>';

// devUrl server for g3-harness.mjs: one webview, one outstanding request at a time.
export async function startG3HarnessServer(port = 1422) {
  const ready = Promise.withResolvers();
  let receiver, command, pending;
  const events = [];
  const evidence = { failures: [], ready: null, closing: null, wire: [] };
  const send = () => {
    if (receiver && command) {
      receiver.setHeader('content-type', 'application/json');
      receiver.end(JSON.stringify(command));
      receiver = command = null;
    }
  };
  const fail = error => { ready.reject(error); pending?.reject(error); pending = null; };
  const server = createServer(async (request, response) => {
    try {
      const path = request.url;
      if (request.method === 'GET' && path === '/') {
        response.setHeader('content-type', 'text/html'); response.end(PAGE);
      } else if (request.method === 'GET' && path === '/g3-harness.mjs') {
        response.setHeader('content-type', 'text/javascript');
        response.end(await readFile(new URL('./g3-harness.mjs', import.meta.url)));
      } else if (request.method === 'GET' && path === '/next') {
        if (receiver) throw new Error('duplicate harness poll');
        receiver = response; send();
      } else if (request.method === 'POST') {
        request.setEncoding('utf8');
        let text = '';
        for await (const chunk of request) text += chunk;
        const body = JSON.parse(text); // envelope only; raw IPC JSON stays a string
        if (path === '/ready') { evidence.ready = body; ready.resolve(body); }
        else if (path === '/event') events.push(body);
        else if (path === '/outcome') {
          if (!pending) throw new Error('unexpected outcome');
          if (body.wire) evidence.wire.push(...body.wire);
          pending.resolve(body); pending = null;
        } else if (path === '/closing') evidence.closing = body;
        else if (path === '/failure') { evidence.failures.push(body); fail(new Error(body.message)); }
        else throw new Error(`unknown route ${path}`);
        response.end('ok');
      } else { response.statusCode = 404; response.end(); }
    } catch (error) { fail(error); response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const request = next => {
    if (pending || command) throw new Error('concurrent harness request');
    pending = Promise.withResolvers();
    const promise = pending.promise;
    command = next; send();
    return promise;
  };
  return {
    evidence, ready: ready.promise,
    /** Events in page delivery order: `{event, payloadRaw}`. */
    events: () => [...events].sort((a, b) => a.seq - b.seq).map(({ event, payloadRaw }) => ({ event, payloadRaw })),
    invoke: (name, argsRaw) => request({ command: name, argsRaw }),
    listen: names => request({ listen: names }),
    requestExit() { command = { close: true }; send(); },
    abort: fail,
    async close() {
      if (receiver) { receiver.end('{"close":true}'); receiver = null; }
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
