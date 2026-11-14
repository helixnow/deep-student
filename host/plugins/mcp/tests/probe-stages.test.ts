import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeTransport, type Transport } from '../src/probe.ts';

// test_helpers.rs:270-376 stage errors and client.rs:1708-1732 send_request timeout, driven
// through the production probe with a transport whose connection state the test controls.

interface FakeTransport extends Transport {
  sent: string[];
  closes: number;
}

function fakeTransport(connected: () => boolean): FakeTransport {
  const waiters: ((error: Error) => void)[] = [];
  const transport: FakeTransport = {
    label: 'fake',
    sent: [],
    closes: 0,
    async send(message: string): Promise<void> { transport.sent.push(message); },
    receive(): Promise<string> { return new Promise<string>((_resolve, reject) => { waiters.push(reject); }); },
    async close(): Promise<void> {
      transport.closes += 1;
      for (const reject of waiters.splice(0)) reject(new Error('Transport error: Channel closed'));
    },
    isConnected: connected,
  };
  return transport;
}

const fakeClock = (): void => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); };

afterEach(() => { vi.useRealTimers(); });

describe('test_helpers.rs::gather_probe_with_progress stages', () => {
  it('connect_with_retry: a transport that never connects fails after the 30s CONNECT_TIMEOUT with 连接失败 and disconnects', async () => {
    fakeClock();
    const transport = fakeTransport(() => false);
    const steps: string[] = [];
    let settled: unknown = undefined;
    const probe = probeTransport(transport, 'fake', step => { steps.push(step); }).then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(29_750);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await probe;
    expect(settled).toEqual({
      success: false, transport: 'fake',
      error: '连接失败: Connection error: 连接超时: Connection error: Transport not connected',
    });
    expect(steps).toEqual(['connecting']);
    expect(transport.sent).toEqual([]);
    expect(transport.closes).toBe(1);
  });

  it('connect_with_retry: a transport connecting during the retry window proceeds to initialize', async () => {
    fakeClock();
    let connected = false;
    const transport = fakeTransport(() => connected);
    const steps: string[] = [];
    void probeTransport(transport, 'fake', step => { steps.push(step); });
    await vi.advanceTimersByTimeAsync(600);
    expect(transport.sent).toEqual([]);
    connected = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(steps).toEqual(['connecting', 'initializing']);
    expect(JSON.parse(transport.sent[0] ?? 'null')).toMatchObject({ method: 'initialize', id: 1 });
  });

  it('send_request: an unanswered initialize settles at exactly 30s with Timeout error: Request timeout, then disconnects', async () => {
    fakeClock();
    const transport = fakeTransport(() => true);
    const logs: string[] = [];
    let settled: unknown = undefined;
    const probe = probeTransport(transport, 'fake', () => undefined, (_level, message) => { logs.push(message); })
      .then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBeUndefined();
    expect(transport.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await probe;
    expect(settled).toEqual({ success: false, transport: 'fake', error: '初始化失败: Timeout error: Request timeout' });
    expect(logs).toEqual(['MCP send_request timeout: method=initialize, id=1, transport=fake']);
    expect(transport.closes).toBe(1);
  });
});
