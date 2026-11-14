import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTransportForConfig, JsonRpcProbe, type Transport } from '../src/probe.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('MCP request lifecycle', () => {
  it('applies the request deadline while transport.send is still pending', async () => {
    vi.useFakeTimers();
    const transport: Transport = {
      label: 'slow-send', send: () => new Promise(() => {}),
      receive: () => new Promise(() => {}), close: async () => {},
    };
    const rpc = new JsonRpcProbe(transport);
    const result = expect(rpc.initialize()).rejects.toThrow('Timeout error: Request timeout');
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    await rpc.close();
  });

  it('settles an in-flight request on close even if send has not returned', async () => {
    const rpc = new JsonRpcProbe({
      label: 'slow-send', send: () => new Promise(() => {}),
      receive: () => new Promise(() => {}), close: async () => {},
    });
    const result = expect(rpc.initialize()).rejects.toThrow('MCP client closed');
    await rpc.close();
    await result;
  });

  it('records the negotiated HTTP protocol before the receive loop consumes initialize', async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      requests.push(init);
      const payload = JSON.parse(init.body as string);
      if (payload.method === 'initialize') return Response.json({
        jsonrpc: '2.0', id: payload.id,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'test', version: '1' } },
      });
      return new Response(null, { status: 202 });
    }));
    const transport = await createTransportForConfig({
      type: 'http', url: 'http://localhost:12345/mcp', api_key: null, headers: {},
    });
    const rpc = new JsonRpcProbe(transport);
    rpc.start();
    try {
      await rpc.initialize();
      expect(new Headers(requests[1]!.headers).get('mcp-protocol-version')).toBe('2025-06-18');
    } finally { await rpc.close(); }
  });

  it('aborts HTTP sends when the transport closes', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => {
      signal = init.signal!;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }));
    const transport = await createTransportForConfig({
      type: 'http', url: 'http://localhost:12345/mcp', api_key: null, headers: {},
    });
    const sent = expect(transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).rejects.toThrow('aborted');
    await transport.close();
    await sent;
    expect(signal?.aborted).toBe(true);
  });

  it('returns an SSE response without waiting for the HTTP stream to end', async () => {
    let stream: ReadableStream<Uint8Array> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const payload = JSON.parse(init.body as string);
      if (payload.method !== 'initialize') return new Response(null, { status: 202 });
      stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id,
            result: { protocolVersion: '2025-06-18', serverInfo: { name: 'open-stream', version: '1' } } })}\n\n`));
          init.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const rpc = new JsonRpcProbe(await createTransportForConfig({
      type: 'http', url: 'http://localhost:12345/mcp', api_key: null, headers: {},
    }));
    rpc.start();
    try { expect((await rpc.initialize()).name).toBe('open-stream'); }
    finally { await rpc.close(); }
    await expect.poll(() => stream?.locked).toBe(false);
  }, 2_000);
});
