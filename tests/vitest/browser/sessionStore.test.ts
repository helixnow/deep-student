import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/features/browser/contentWindow', () => ({
  ensureBrowserContentWindow: vi.fn(async () => true),
  showBrowserContentWindow: vi.fn(async () => true),
  hideBrowserContentWindow: vi.fn(async () => undefined),
  closeBrowserContentWindow: vi.fn(async () => undefined),
  isBrowserContentWindowOpen: vi.fn(async () => false),
  BROWSER_CONTENT_LABEL: 'browser-content',
}));

// Gate behavior has dedicated coverage in features/browser/__tests__/gates.test.ts.
// These store tests exercise navigation/state mirroring with both product gates open.
vi.mock('@/features/browser/gates', async () => {
  const actual = await vi.importActual<typeof import('@/features/browser/gates')>(
    '@/features/browser/gates',
  );
  return {
    ...actual,
    assertBrowserGatesOpen: vi.fn(async () => ({
      workbenchModeEnabled: true,
      browserEnabled: true,
      open: true,
    })),
  };
});

import { invoke } from '@tauri-apps/api/core';
import {
  BrowserApiError,
  isCommandMissingError,
  parseBrowserSessionSnapshot,
} from '@/features/browser/browserApi';
import {
  INITIAL_BROWSER_SESSION_STATE,
  useBrowserSessionStore,
} from '@/features/browser/sessionStore';
import {
  BROWSER_APP_TYPE_ID,
  BROWSER_CONTENT_LABEL,
} from '@/features/browser/types';

const invokeMock = vi.mocked(invoke);

function resetStore() {
  useBrowserSessionStore.setState({ ...INITIAL_BROWSER_SESSION_STATE });
}

describe('browser types', () => {
  it('exports fixed app typeId and content label', () => {
    expect(BROWSER_APP_TYPE_ID).toBe('browser');
    expect(BROWSER_CONTENT_LABEL).toBe('browser-content');
  });
});

describe('parseBrowserSessionSnapshot', () => {
  it('normalizes snake_case Rust DTO into chrome mirror fields', () => {
    const snap = parseBrowserSessionSnapshot({
      session_id: 'sess-1',
      current_url: 'https://example.com/a',
      current_title: 'Example',
      can_go_back: true,
      can_go_forward: false,
      control_mode: 'agent',
      is_loading: false,
      history_index: 1,
      history: [
        { url: 'https://example.com/', title: 'Home', seq: 0 },
        { url: 'https://example.com/a', title: 'Example', seq: 1 },
      ],
    });

    expect(snap.sessionId).toBe('sess-1');
    expect(snap.currentUrl).toBe('https://example.com/a');
    expect(snap.title).toBe('Example');
    expect(snap.canGoBack).toBe(true);
    expect(snap.canGoForward).toBe(false);
    expect(snap.controlMode).toBe('agent');
    expect(snap.history).toHaveLength(2);
    expect(snap.historyIndex).toBe(1);
  });

  it('accepts Rust BrowserSessionState aliases (id/url) and null get_state', () => {
    const snap = parseBrowserSessionSnapshot({
      id: 'bs_1',
      url: 'https://baidu.com/',
      title: '百度',
      canGoBack: false,
      canGoForward: false,
      controlMode: 'User',
      loading: false,
      historyIndex: 0,
      history: [],
    });
    expect(snap.sessionId).toBe('bs_1');
    expect(snap.currentUrl).toBe('https://baidu.com/');
    expect(snap.controlMode).toBe('user');
    expect(parseBrowserSessionSnapshot(null).sessionId).toBeNull();
  });
});

describe('browserApi command-missing errors', () => {
  it('maps missing command to friendly BrowserApiError', () => {
    expect(isCommandMissingError(new Error('Command browser_get_state not found'))).toBe(true);
    const err = new BrowserApiError(
      'browser_get_state',
      '浏览器后端命令尚未就绪（browser_get_state）。请确认 workbench 浏览器功能已启用并完成接线。',
      'BROWSER_COMMAND_MISSING',
    );
    expect(err.code).toBe('BROWSER_COMMAND_MISSING');
  });
});

describe('useBrowserSessionStore', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
  });

  it('hydrateFromRust mirrors Rust history authority into the store', async () => {
    invokeMock.mockResolvedValueOnce({
      sessionId: 's1',
      currentUrl: 'https://learn.test/page',
      title: 'Page',
      canGoBack: true,
      canGoForward: true,
      controlMode: 'user',
      loading: false,
      historyIndex: 1,
      history: [
        { url: 'https://learn.test/', title: 'Home' },
        { url: 'https://learn.test/page', title: 'Page' },
        { url: 'https://learn.test/next', title: 'Next' },
      ],
    });

    await useBrowserSessionStore.getState().hydrateFromRust();

    const state = useBrowserSessionStore.getState();
    expect(invokeMock).toHaveBeenCalledWith('browser_get_state', {});
    expect(state.sessionId).toBe('s1');
    expect(state.currentUrl).toBe('https://learn.test/page');
    expect(state.title).toBe('Page');
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(true);
    expect(state.history).toHaveLength(3);
    expect(state.historyIndex).toBe(1);
    expect(state.addressDraft).toBe('https://learn.test/page');
    expect(state.loading).toBe(false);
  });

  it('hydrateFromRust accepts an explicit snapshot without invoking', async () => {
    await useBrowserSessionStore.getState().hydrateFromRust({
      session_id: 'direct',
      current_url: 'https://direct.test',
      title: 'Direct',
      can_go_back: false,
      can_go_forward: false,
      control_mode: 'agent',
      history: [{ url: 'https://direct.test', title: 'Direct' }],
      history_index: 0,
    });

    expect(invokeMock).not.toHaveBeenCalled();
    const state = useBrowserSessionStore.getState();
    expect(state.sessionId).toBe('direct');
    expect(state.controlMode).toBe('agent');
    expect(state.history).toEqual([{ url: 'https://direct.test', title: 'Direct', visitedAt: null, seq: undefined }]);
  });

  it('takeOver forces controlMode to user from Rust snapshot', async () => {
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      sessionId: 's1',
      currentUrl: 'https://example.com',
      controlMode: 'agent',
    });

    invokeMock.mockResolvedValueOnce({
      sessionId: 's1',
      currentUrl: 'https://example.com',
      title: 'Example',
      canGoBack: false,
      canGoForward: false,
      controlMode: 'user',
      loading: false,
      history: [{ url: 'https://example.com' }],
      historyIndex: 0,
    });

    await useBrowserSessionStore.getState().takeOver();

    expect(invokeMock).toHaveBeenCalledWith('browser_take_over');
    expect(useBrowserSessionStore.getState().controlMode).toBe('user');
    expect(useBrowserSessionStore.getState().loading).toBe(false);
  });

  it('takeOver switches to user and propagates command-missing failure', async () => {
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      controlMode: 'agent',
    });
    invokeMock.mockRejectedValueOnce(new Error('Command browser_take_over not found'));

    await expect(useBrowserSessionStore.getState().takeOver()).rejects.toMatchObject({
      code: 'BROWSER_COMMAND_MISSING',
    });

    const state = useBrowserSessionStore.getState();
    expect(state.controlMode).toBe('user');
    expect(state.lastError).toMatch(/尚未就绪|browser_take_over/);
  });

  it('navigate replaces history mirror from Rust (no local stack authority)', async () => {
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      sessionId: 's1',
      currentUrl: 'https://a.test',
      history: [{ url: 'https://a.test', title: 'A' }],
      historyIndex: 0,
      canGoBack: false,
      canGoForward: false,
      controlMode: 'agent',
    });

    invokeMock
      // 用户导航先同步 browser_take_over，再执行 browser_navigate。
      .mockResolvedValueOnce({
        sessionId: 's1',
        currentUrl: 'https://a.test',
        title: 'A',
        canGoBack: false,
        canGoForward: false,
        controlMode: 'user',
        loading: false,
        historyIndex: 0,
        history: [{ url: 'https://a.test', title: 'A' }],
      })
      .mockResolvedValueOnce({
        sessionId: 's1',
        currentUrl: 'https://b.test',
        title: 'B',
        canGoBack: true,
        canGoForward: false,
        controlMode: 'user',
        loading: false,
        historyIndex: 1,
        history: [
          { url: 'https://a.test', title: 'A' },
          { url: 'https://b.test', title: 'B' },
        ],
      });

    await useBrowserSessionStore.getState().navigate('https://b.test');

    expect(invokeMock).toHaveBeenCalledWith('browser_navigate', {
      sessionId: 's1',
      url: 'https://b.test',
      fromAgent: false,
    });
    const state = useBrowserSessionStore.getState();
    expect(state.currentUrl).toBe('https://b.test');
    expect(state.history).toHaveLength(2);
    expect(state.history.map((h) => h.url)).toEqual(['https://a.test', 'https://b.test']);
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(false);
    // 用户导航硬打断 agent
    expect(state.controlMode).toBe('user');
  });

  it('navigate without session opens first (bare host → https)', async () => {
    invokeMock
      // 尚无 session 时 take_over 可失败，但 open_session 必须继续。
      .mockRejectedValueOnce(new Error('NOT_FOUND: no active browser session'))
      .mockResolvedValueOnce({
        id: 'bs_new',
        url: 'https://baidu.com',
        title: '',
        canGoBack: false,
        canGoForward: false,
        controlMode: 'user',
        loading: true,
        historyIndex: 0,
        history: [{ url: 'https://baidu.com' }],
      });

    await useBrowserSessionStore.getState().navigate('baidu.com');

    expect(invokeMock).toHaveBeenCalledWith('browser_open_session', {
      url: 'https://baidu.com',
      fromAgent: false,
    });
    expect(useBrowserSessionStore.getState().sessionId).toBe('bs_new');
    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://baidu.com');
    // Command completion only means the native WebView accepted navigation.
    // Preserve Rust's page-loading state so chrome keeps showing the stop action.
    expect(useBrowserSessionStore.getState().loading).toBe(true);
  });

  it('back/forward only invoke when canGo* allows, then mirror Rust flags', async () => {
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      sessionId: 's1',
      currentUrl: 'https://b.test',
      canGoBack: true,
      canGoForward: false,
      history: [
        { url: 'https://a.test' },
        { url: 'https://b.test' },
      ],
      historyIndex: 1,
    });

    invokeMock
      .mockResolvedValueOnce({
        sessionId: 's1',
        currentUrl: 'https://b.test',
        title: 'B',
        canGoBack: true,
        canGoForward: false,
        controlMode: 'user',
        history: [
          { url: 'https://a.test' },
          { url: 'https://b.test' },
        ],
        historyIndex: 1,
      })
      .mockResolvedValueOnce({
        sessionId: 's1',
        currentUrl: 'https://a.test',
        title: 'A',
        canGoBack: false,
        canGoForward: true,
        controlMode: 'user',
        history: [
          { url: 'https://a.test' },
          { url: 'https://b.test' },
        ],
        historyIndex: 0,
      });

    await useBrowserSessionStore.getState().back();
    expect(invokeMock).toHaveBeenCalledWith('browser_back', { sessionId: 's1' });
    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://a.test');
    expect(useBrowserSessionStore.getState().canGoForward).toBe(true);

    invokeMock.mockClear();
    await useBrowserSessionStore.getState().forward();
    // canGoForward is true after back
    expect(invokeMock).toHaveBeenCalledWith('browser_forward', { sessionId: 's1' });
  });

  it('back is a no-op when canGoBack is false (does not invent history)', async () => {
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      canGoBack: false,
      history: [{ url: 'https://only.test' }],
      historyIndex: 0,
    });

    await useBrowserSessionStore.getState().back();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useBrowserSessionStore.getState().history).toHaveLength(1);
  });
});

describe('useBrowserSessionStore stopLoading (loading 期停止/改道)', () => {
  const seededState = {
    ...INITIAL_BROWSER_SESSION_STATE,
    sessionId: 's1',
    currentUrl: 'https://a.test',
    addressDraft: 'https://a.test',
    canGoBack: true,
    history: [{ url: 'https://a.test', title: 'A' }],
    historyIndex: 0,
  };

  function snapshotFor(url: string, title = url) {
    return {
      sessionId: 's1',
      currentUrl: url,
      title,
      canGoBack: true,
      canGoForward: false,
      controlMode: 'user',
      loading: false,
      history: [{ url: 'https://a.test', title: 'A' }, { url, title }],
      historyIndex: 1,
    };
  }

  beforeEach(() => {
    invokeMock.mockReset();
    useBrowserSessionStore.setState({ ...seededState });
  });

  it('is a no-op when nothing is loading', () => {
    useBrowserSessionStore.getState().stopLoading();
    expect(useBrowserSessionStore.getState().loading).toBe(false);
    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://a.test');
  });

  it('unlocks chrome immediately and discards the stale in-flight receipt', async () => {
    let resolveNavigate: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'browser_take_over') return Promise.resolve(snapshotFor('https://a.test', 'A'));
      if (cmd === 'browser_navigate') {
        return new Promise((resolve) => {
          resolveNavigate = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected invoke: ${String(cmd)}`));
    });

    const navPromise = useBrowserSessionStore.getState().navigate('https://slow.test');
    // runNav 在首个 await 前同步置忙
    expect(useBrowserSessionStore.getState().loading).toBe(true);

    useBrowserSessionStore.getState().stopLoading();
    expect(useBrowserSessionStore.getState().loading).toBe(false);

    // stopLoading 先于 browser_navigate 上桩发出（还停在 take_over 微任务），
    // 等 invoke 真正发生后再放行迟到回执
    await vi.waitFor(() => {
      if (typeof resolveNavigate !== 'function') throw new Error('navigate not invoked yet');
    });
    // 迟到回执：generation 已失配，必须被丢弃而不是覆盖镜像
    resolveNavigate!(snapshotFor('https://slow.test', 'Slow'));
    await navPromise;

    const state = useBrowserSessionStore.getState();
    expect(state.currentUrl).toBe('https://a.test');
    expect(state.loading).toBe(false);
  });

  it('releases the navigation lock so redirecting mid-load works (no BROWSER_BUSY)', async () => {
    let resolveFirst!: (value: unknown) => void;
    let navigateCalls = 0;
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'browser_take_over') return Promise.resolve(snapshotFor('https://a.test', 'A'));
      if (cmd === 'browser_navigate') {
        navigateCalls += 1;
        if (navigateCalls === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(snapshotFor('https://b.test', 'B'));
      }
      return Promise.reject(new Error(`unexpected invoke: ${String(cmd)}`));
    });

    const firstNav = useBrowserSessionStore.getState().navigate('https://slow.test');
    expect(useBrowserSessionStore.getState().loading).toBe(true);

    // UI 语义：loading 期改道 = 先 stopLoading 再 navigate（BrowserAppWindow.handleNavigate）
    useBrowserSessionStore.getState().stopLoading();
    await useBrowserSessionStore.getState().navigate('https://b.test');

    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://b.test');

    // 第一段导航的迟到回执依旧被丢弃，不回跳
    resolveFirst(snapshotFor('https://slow.test', 'Slow'));
    await firstNav;
    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://b.test');
    expect(useBrowserSessionStore.getState().loading).toBe(false);
  });

  it('lets back() run right after stopping a load (loading 期不再锁后退)', async () => {
    let resolveNavigate!: (value: unknown) => void;
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'browser_take_over') return Promise.resolve(snapshotFor('https://a.test', 'A'));
      if (cmd === 'browser_navigate') {
        return new Promise((resolve) => {
          resolveNavigate = resolve;
        });
      }
      if (cmd === 'browser_back') {
        return Promise.resolve({
          sessionId: 's1',
          currentUrl: 'https://prev.test',
          title: 'Prev',
          canGoBack: false,
          canGoForward: true,
          controlMode: 'user',
          loading: false,
          history: [{ url: 'https://prev.test', title: 'Prev' }, { url: 'https://a.test', title: 'A' }],
          historyIndex: 0,
        });
      }
      return Promise.reject(new Error(`unexpected invoke: ${String(cmd)}`));
    });

    const navPromise = useBrowserSessionStore.getState().navigate('https://slow.test');
    expect(useBrowserSessionStore.getState().loading).toBe(true);

    // UI 语义：loading 期点后退 = 先 stopLoading 再 back（BrowserAppWindow.handleBack）
    useBrowserSessionStore.getState().stopLoading();
    await useBrowserSessionStore.getState().back();

    expect(invokeMock).toHaveBeenCalledWith('browser_back', { sessionId: 's1' });
    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://prev.test');

    resolveNavigate(snapshotFor('https://slow.test', 'Slow'));
    await navPromise;
    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://prev.test');
  });
});
