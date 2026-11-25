import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({
  isWebUiShell: vi.fn(() => true),
}));

vi.mock('@/utils/platform', () => platformMock);
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => undefined) }));

import i18n from 'i18next';
import {
  dismissSafeModeTransitionOverlay,
  enterSafeModeAndRestart,
  exitSafeModeAndRestart,
} from '../safeMode';

describe('safeMode WebUI & URL lifecycle (S4-08 & S4-16)', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    dismissSafeModeTransitionOverlay();
    platformMock.isWebUiShell.mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  afterEach(() => {
    dismissSafeModeTransitionOverlay();
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

  it('S4-08: renders an immediate full-screen Safe Mode transition overlay before fetch/reload completes', async () => {
    let resolveEnter!: (res: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { resolveEnter = resolve; })),
    );
    const reload = vi.fn();
    document.documentElement.lang = 'zh-CN';
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://127.0.0.1:4100/', search: '', reload, assign: vi.fn() },
    });

    const pending = enterSafeModeAndRestart();

    const overlay = document.querySelector('[data-testid="safe-mode-transition-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('data-mode')).toBe('enter');
    expect(overlay?.textContent).toContain('正在切换至安全模式排查，正在隔离社区插件…');
    expect(reload).not.toHaveBeenCalled();

    resolveEnter(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await pending;
    expect(reload).toHaveBeenCalledTimes(1);

    dismissSafeModeTransitionOverlay();
    document.documentElement.lang = 'en-US';
    const prevLang = i18n.language;
    i18n.language = 'en-US';
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
      await enterSafeModeAndRestart();
      const enOverlay = document.querySelector('[data-testid="safe-mode-transition-overlay"]');
      expect(enOverlay?.textContent).toContain('Switching to Safe Mode');
    } finally {
      i18n.language = prevLang;
      document.documentElement.lang = '';
    }
  });
});
