import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import { handshakeResponse, encodeFrame, closePayload, OPCODES } from '../equivalence/__fixtures__/websocket.ts';
import { createTransportForConfig } from '../src/probe.ts';

it('ends receive and rejects sends after the WebSocket server closes', async () => {
  const server = createServer();
  let peer: Socket | undefined;
  let upgraded!: () => void;
  const ready = new Promise<void>(resolve => { upgraded = resolve; });
  server.on('upgrade', (request, socket) => {
    peer = socket as Socket;
    socket.write(handshakeResponse(request.headers['sec-websocket-key']!));
    upgraded();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const transport = await createTransportForConfig({ type: 'websocket', url: `ws://127.0.0.1:${address.port}`, env: {} });
  try {
    await ready;
    // send waits for the client to finish opening, not just the server handshake.
    await transport.send('{}');
    let receiveEnded = false;
    const receiving = transport.receive().then(() => 'message', () => { receiveEnded = true; return 'closed'; });
    peer!.end(encodeFrame(OPCODES.close, closePayload(1000)));
    await expect.poll(() => receiveEnded, { timeout: 500 }).toBe(true);
    expect(transport.isConnected?.()).toBe(false);
    expect(await receiving).toBe('closed');
    await expect(transport.receive()).rejects.toThrow('WebSocket 连接已关闭');
    await expect(transport.send('{}')).rejects.toThrow('WebSocket 连接已关闭');
  } finally {
    await transport.close();
    peer?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 2_000);
