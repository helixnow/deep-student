import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ takeOver: vi.fn(), navigate: vi.fn(), openSession: vi.fn() }));
vi.mock('../browserApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../browserApi')>(),
  ...api,
}));
vi.mock('../contentWindow', () => ({
  ensureBrowserContentWindow: vi.fn(async () => true),
  closeBrowserContentWindow: vi.fn(async () => {}),
  hideBrowserContentWindow: vi.fn(async () => {}),
  showBrowserContentWindow: vi.fn(async () => true),
}));

import { useBrowserSessionStore } from '../sessionStore';

describe('B18 navigation cancellation during slow takeover', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useBrowserSessionStore.getState().reset();
    useBrowserSessionStore.setState({ sessionId: 'b18-session' });
  });

  it.each(['resolved', 'rejected'] as const)('does not dispatch a stopped navigation after takeover %s', async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    api.takeOver.mockImplementationOnce(() => new Promise<void>((res, rej) => { resolve = res; reject = rej; }));
    const navigation = useBrowserSessionStore.getState().navigate('https://stopped.example');
    expect(api.takeOver).toHaveBeenCalledTimes(1);
    useBrowserSessionStore.getState().stopLoading();
    if (outcome === 'resolved') resolve();
    else reject(new Error('takeover unavailable'));
    await navigation;
    expect(api.navigate).not.toHaveBeenCalled();
    expect(api.openSession).not.toHaveBeenCalled();
    expect(useBrowserSessionStore.getState().loading).toBe(false);
  });
});
