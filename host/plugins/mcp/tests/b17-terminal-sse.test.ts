import { createServer, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createSseProbeTransport } from '../src/probe.ts';

it('rejects subsequent receives and sends after the SSE endpoint stream ends', async () => {
  let stream: ServerResponse | undefined;
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      posts += 1;
      request.resume();
      response.writeHead(202).end();
      return;
    }
    stream = response;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: endpoint\ndata: /messages\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const transport = createSseProbeTransport(`http://127.0.0.1:${address.port}/sse`, null);
  try {
    await expect.poll(() => transport.isConnected?.()).toBe(true);
    stream!.end();
    await expect.poll(() => transport.isConnected?.()).toBe(false);
    let receiveError: string | undefined;
    const received = transport.receive().catch((error: Error) => { receiveError = error.message; });
    await expect.poll(() => receiveError, { timeout: 300 }).toBe('SSE 连接已关闭');
    await received;
    await expect(transport.send('{}')).rejects.toThrow('SSE 连接已关闭');
    expect(posts).toBe(0);
  } finally {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
