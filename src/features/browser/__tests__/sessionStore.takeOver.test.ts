/**
 * ACR R2-10 — forceUserControl → browser_take_over；agent navigate 不打闩锁
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const takeOverApi = vi.hoisted(() =>
  vi.fn(async () => ({
    sessionId: 's1',
    currentUrl: 'https://example.com',
    title: 'Example',
    canGoBack: false,
    canGoForward: false,
    controlMode: 'user' as const,
    loading: false,
    history: [],
    historyIndex: -1,
    error: null,
  })),
);

const navigateApi = vi.hoisted(() =>
  vi.fn(async () => ({
    sessionId: 's1',
    currentUrl: 'https://example.com/a',
    title: 'A',
    canGoBack: true,
    canGoForward: false,
    controlMode: 'agent' as const,
    loading: false,
    history: [],
    historyIndex: 0,
    error: null,
  })),
);

vi.mock('../browserApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browserApi')>();
  return {
    ...actual,
    takeOver: takeOverApi,
    navigate: navigateApi,
    openSession: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    getState: vi.fn(),
    closeSession: vi.fn(),
    focusContent: vi.fn(),
  };
});

vi.mock('../contentWindow', () => ({
  ensureBrowserContentWindow: vi.fn(async () => true),
  closeBrowserContentWindow: vi.fn(async () => {}),
  hideBrowserContentWindow: vi.fn(async () => {}),
  showBrowserContentWindow: vi.fn(async () => true),
}));

import {
  INITIAL_BROWSER_SESSION_STATE,
  useBrowserSessionStore,
} from '../sessionStore';

describe('sessionStore ControlMode R2-10', () => {
  beforeEach(() => {
    takeOverApi.mockClear();
    navigateApi.mockClear();
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      sessionId: 's1',
      currentUrl: 'https://example.com',
      controlMode: 'agent',
      canGoBack: true,
    });
  });

  it('takeOver 以 Rust 回执 hydrate 且 controlMode=user', async () => {
    await useBrowserSessionStore.getState().takeOver();
    expect(takeOverApi).toHaveBeenCalledTimes(1);
    expect(useBrowserSessionStore.getState().controlMode).toBe('user');
  });

  it('用户 navigate 默认 forceUserControl → 先 takeOver', async () => {
    await useBrowserSessionStore.getState().navigate('https://example.com/a');
    expect(takeOverApi).toHaveBeenCalled();
    expect(navigateApi).toHaveBeenCalled();
  });

  it('agent navigate(forceUserControl:false) 不调用 takeOver', async () => {
    await useBrowserSessionStore
      .getState()
      .navigate('https://example.com/a', { forceUserControl: false });
    expect(takeOverApi).not.toHaveBeenCalled();
    expect(navigateApi).toHaveBeenCalled();
  });
});
