import { describe, expect, it } from 'vitest';
import { JsonRpcProbe, type Transport } from '../src/probe.ts';
import type { McpEvent } from '../src/client-dispatch.ts';

interface Waiter {
  resolve(value: string): void;
  reject(error: Error): void;
}

/**
 * In-memory transport: answers `initialize` and lets the test push/refuse
 * inbound messages. Mirrors the transport contract `JsonRpcProbe` relies on.
 */
class FakeTransport implements Transport {
  readonly label = 'fake';
  readonly sent: string[] = [];
  private readonly inbound: string[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  send(message: string): Promise<void> {
    this.sent.push(message);
    const parsed = JSON.parse(message) as { id?: unknown; method?: string };
    if (parsed.method === 'initialize' && parsed.id !== undefined) {
      this.push(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'event-server', version: '1.2.3' },
        },
      }));
    }
    return Promise.resolve();
  }

  receive(): Promise<string> {
    const value = this.inbound.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.reject(new Error('transport closed'));
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  close(): Promise<void> {
    this.closed = true;
    this.refuse(new Error('transport closed'));
    return Promise.resolve();
  }

  fail(error: Error): void {
    this.refuse(error);
  }

  private push(message: string): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve(message);
    else this.inbound.push(message);
  }

  private refuse(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => { setTimeout(resolve, 1); });
  }
  throw new Error('condition was not met');
}

describe('MCP client lifecycle events (client.rs::EventEmitter)', () => {
  it('emits Connected, ServerInfoReceived and Disconnected in order', async () => {
    const transport = new FakeTransport();
    const probe = new JsonRpcProbe(transport, { timeoutMs: 1_000 });
    const events: McpEvent[] = [];
    probe.onEvent(event => { events.push(event); });

    probe.start();
    const server = await probe.initialize();
    expect(server).toEqual({
      name: 'event-server',
      version: '1.2.3',
      protocol_version: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
    });
    await probe.close();

    expect(events.map(event => event.type)).toEqual([
      'Connected', 'ServerInfoReceived', 'Disconnected',
    ]);
    const info = events[1];
    expect(info).toBeDefined();
    if (info === undefined || info.type !== 'ServerInfoReceived') {
      throw new Error('ServerInfoReceived was not the second lifecycle event');
    }
    expect(info.server).toEqual(server);
  });

  it('emits Error on a receive failure but not on a deliberate close', async () => {
    const transport = new FakeTransport();
    const probe = new JsonRpcProbe(transport, { timeoutMs: 1_000 });
    const events: McpEvent[] = [];
    probe.onEvent(event => { events.push(event); });

    probe.start();
    transport.fail(new Error('socket reset'));
    await waitFor(() => events.length >= 2);
    expect(events).toEqual([
      { type: 'Connected' },
      { type: 'Error', message: 'socket reset' },
    ]);

    await probe.close();
    expect(events.map(event => event.type)).toEqual(['Connected', 'Error', 'Disconnected']);
  });
});
