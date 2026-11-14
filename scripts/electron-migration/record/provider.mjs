import { createServer } from 'node:http';
import { firstDifference, parseExact, stringifyExact } from './json.mjs';

// Scripted external dependency only. Never used as the implementation under test.
// Each backend receives a fresh provider with exactly the same ordered script.
export async function scriptedProvider(script) {
  const requests = [];
  const errors = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      // Incoming HTTP chunks may split a UTF-8 scalar; use the stream decoder,
      // not Buffer.toString independently for every chunk.
      request.setEncoding('utf8');
      for await (const chunk of request) body += chunk;
      const actual = { method: request.method, path: request.url, body: body ? parseExact(body) : null };
      const step = script[requests.length];
      requests.push(actual);
      if (!step || firstDifference(step.request, actual)) {
        errors.push({ expected: step?.request, actual });
        response.writeHead(500).end('unexpected scripted provider request');
        return;
      }
      response.writeHead(step.status ?? 200, step.headers ?? { 'content-type': 'application/json' });
      response.flushHeaders();
      for (const chunk of step.chunks) {
        await new Promise((resolve, reject) => response.write(chunk, error => error ? reject(error) : resolve()));
      }
      // Send queued bytes followed by TCP EOF, but omit HTTP's terminal chunk.
      // destroy() here can discard the prefix and simulate a pre-header failure.
      if (step.disconnect) response.socket.end();
      else response.end();
    } catch (error) {
      errors.push(String(error));
      response.destroy();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests,
    assertConsumed() {
      if (errors.length || requests.length !== script.length) throw new Error(`provider script mismatch: ${stringifyExact({ errors, consumed: requests.length, expected: script.length })}`);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
