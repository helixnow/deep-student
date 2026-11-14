import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Bus = typeof import('@/shared/debug/bus');

async function freshBus(): Promise<Bus> {
  vi.resetModules();
  return import('@/shared/debug/bus');
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('debug bus (FE-B7)', () => {
  it('queues emits until a panel serves the channel, then replays them in order and delivers synchronously', async () => {
    const { debugChannel, serveDebugChannel } = await freshBus();
    const channel = debugChannel<{ log: (stage: string, n: number) => void }>('test');
    const log = channel.emitter('log');
    log('a', 1);
    log('b', 2);
    const seen: string[] = [];
    const stop = serveDebugChannel('test', { log: (stage: string, n: number) => seen.push(`${stage}${n}`) });
    expect(seen).toEqual(['a1', 'b2']);
    log('c', 3);
    expect(seen).toEqual(['a1', 'b2', 'c3']);
    stop();
    log('d', 4);
    expect(seen).toEqual(['a1', 'b2', 'c3']);
  });

  it('answers queries only while served', async () => {
    const { debugChannel, serveDebugChannel } = await freshBus();
    const capture = debugChannel<{ capture: (el: string) => { tag: string } }>('dom').query('capture');
    expect(capture('div')).toBeUndefined();
    serveDebugChannel('dom', { capture: (el: string) => ({ tag: el }) });
    expect(capture('div')).toEqual({ tag: 'div' });
  });

  it('keeps the newest 500 queued emits per channel and isolates handler errors', async () => {
    const { debugBus, serveDebugChannel } = await freshBus();
    for (let i = 0; i < 600; i += 1) debugBus.emit('busy', 'push', i);
    const received: number[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    serveDebugChannel('busy', {
      push: (i: number) => {
        if (i === 100) throw new Error('boom');
        received.push(i);
      },
    });
    // 100…599 were kept; 100 threw during the replay without stopping it.
    expect(received).toHaveLength(499);
    expect(received[0]).toBe(101);
    expect(received.at(-1)).toBe(599);
    expect(warn).toHaveBeenCalledTimes(1);
    debugBus.emit('busy', 'push', 100);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('is a no-op in production builds', async () => {
    vi.stubEnv('DEV', false);
    const { debugBus, debugChannel, serveDebugChannel } = await freshBus();
    const handler = vi.fn(() => 'answer');
    debugBus.emit('prod', 'op', 1);
    serveDebugChannel('prod', { op: handler });
    debugBus.emit('prod', 'op', 2);
    expect(debugChannel<{ op: () => string }>('prod').query('op')()).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
