import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({
  isWebUiShell: vi.fn(() => true),
}));

vi.mock('@/utils/platform', () => platformMock);
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => undefined) }));

import { enterSafeModeAndRestart, exitSafeModeAndRestart } from '../safeMode';

describe('safeMode WebUI & URL lifecycle (S4-16)', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    platformMock.isWebUiShell.mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('calls POST /api/safe-mode/exit before reloading in WebUI mode', async () => {
    const reload = vi.fn();
    const assign = vi.fn();
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://127.0.0.1:4100/?safeMode=1', search: '?safeMode=1', reload, assign },
    });

    await exitSafeModeAndRestart();

    expect(replaceState).toHaveBeenCalledWith(null, '', 'http://127.0.0.1:4100/');
    expect(fetch).toHaveBeenCalledWith('/api/safe-mode/exit', {
      method: 'POST',
      credentials: 'same-origin',
    });
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:4100/');
  });

  it('calls POST /api/safe-mode/enter and reloads in WebUI mode', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://127.0.0.1:4100/', search: '', reload, assign: vi.fn() },
    });

    await enterSafeModeAndRestart();

    expect(fetch).toHaveBeenCalledWith('/api/safe-mode/enter', {
      method: 'POST',
      credentials: 'same-origin',
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
