// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

vi.mock('../../electron/preload/bridge.ts', () => ({ installTauriBridge: vi.fn() }));
import { bootstrapWebClient } from '../client/bootstrap.ts';

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  constructor(_url: string) { super(); FakeSocket.instances.push(this); }
  send() {}
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
}

it('does not let online/visibility events bypass login or resolve connected before the handshake', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('WebSocket', FakeSocket);
  let resolveHealth!: (value: { status: number }) => void;
  const health = new Promise<{ status: number }>((resolve) => { resolveHealth = resolve; });
  const fetchMock = vi.fn().mockReturnValueOnce(health).mockResolvedValue({ status: 200, ok: true });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const client = bootstrapWebClient();
    let connected = false;
    void client.connected.then(() => { connected = true; });
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(connected).toBe(false);

    resolveHealth({ status: 401 });
    await vi.waitFor(() => expect(document.querySelector('#ds-web-token-form')).not.toBeNull());
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.instances).toHaveLength(0);
    const input = document.querySelector<HTMLInputElement>('#ds-web-token-input')!;
    input.value = 'test-token';
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(connected).toBe(false);
    FakeSocket.instances[0]!.open();
    await client.connected;
    expect(connected).toBe(true);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  }
});
