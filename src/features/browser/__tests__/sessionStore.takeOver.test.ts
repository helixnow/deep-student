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
    agentAutomationSupported: true,
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
    agentAutomationSupported: true,
    error: null,
  })),
);

const openSessionApi = vi.hoisted(() =>
  vi.fn(async () => ({
    sessionId: 's-new',
    currentUrl: 'https://example.com/new',
    title: 'New',
    canGoBack: false,
    canGoForward: false,
    controlMode: 'agent' as const,
    loading: false,
    history: [{ url: 'https://example.com/new', title: 'New' }],
    historyIndex: 0,
    agentAutomationSupported: true,
    error: null,
  })),
);

const getStateApi = vi.hoisted(() => vi.fn());
const closeSessionApi = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../browserApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browserApi')>();
  return {
    ...actual,
    takeOver: takeOverApi,
    navigate: navigateApi,
    openSession: openSessionApi,
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    getState: getStateApi,
    closeSession: closeSessionApi,
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
import {
  __applyClosedPayloadForTest,
  __resetControlModeSyncForTest,
} from '../controlModeSync';

describe('sessionStore ControlMode R2-10', () => {
  beforeEach(() => {
    __resetControlModeSyncForTest();
    takeOverApi.mockClear();
    navigateApi.mockClear();
    openSessionApi.mockClear();
    getStateApi.mockReset();
    closeSessionApi.mockClear();
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

  it('关闭后忽略迟到的 takeOver 回执，不复活 session', async () => {
    let resolveTakeOver!: (value: Awaited<ReturnType<typeof takeOverApi>>) => void;
    takeOverApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTakeOver = resolve;
        }),
    );

    const takingOver = useBrowserSessionStore.getState().takeOver();
    await useBrowserSessionStore.getState().closeSession();
    resolveTakeOver({
      sessionId: 'stale-takeover',
      currentUrl: 'https://stale.example',
      title: 'Stale',
      canGoBack: false,
      canGoForward: false,
      controlMode: 'user',
      loading: false,
      history: [],
      historyIndex: -1,
      agentAutomationSupported: true,
      error: null,
    });
    await takingOver;

    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: null,
      currentUrl: '',
      controlMode: 'user',
      loading: false,
    });
  });

  it('reset 后忽略迟到的 takeOver 回执，不复活 chrome', async () => {
    let resolveTakeOver!: (value: Awaited<ReturnType<typeof takeOverApi>>) => void;
    takeOverApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTakeOver = resolve;
        }),
    );

    const takingOver = useBrowserSessionStore.getState().takeOver();
    useBrowserSessionStore.getState().reset();
    resolveTakeOver({
      sessionId: 'stale-takeover',
      currentUrl: 'https://stale.example',
      title: 'Stale',
      canGoBack: false,
      canGoForward: false,
      controlMode: 'user',
      loading: false,
      history: [],
      historyIndex: -1,
      agentAutomationSupported: true,
      error: null,
    });
    await takingOver;

    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: null,
      currentUrl: '',
      contentVisible: false,
      loading: false,
    });
  });

  it('reset 后迟到的 takeOver 失败不污染空状态', async () => {
    let rejectTakeOver!: (reason?: unknown) => void;
    takeOverApi.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTakeOver = reject;
        }),
    );

    const takingOver = useBrowserSessionStore.getState().takeOver();
    useBrowserSessionStore.getState().reset();
    rejectTakeOver(new Error('late takeover failure'));

    await expect(takingOver).rejects.toThrow('late takeover failure');
    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: null,
      currentUrl: '',
      contentVisible: false,
      loading: false,
      error: null,
      lastError: null,
    });
  });

  it('用户 navigate 默认 forceUserControl → 先 takeOver', async () => {
    await useBrowserSessionStore.getState().navigate('https://example.com/a');
    expect(takeOverApi).toHaveBeenCalled();
    expect(navigateApi).toHaveBeenCalled();
  });

  it('agent navigate(forceUserControl:false) 不调用 takeOver', async () => {
    await useBrowserSessionStore
      .getState()
      .navigate('https://example.com/a', { forceUserControl: false, fromAgent: true });
    expect(takeOverApi).not.toHaveBeenCalled();
    expect(navigateApi).toHaveBeenCalledWith('https://example.com/a', 's1', {
      fromAgent: true,
    });
  });

  it('无 session 的 agent navigate 通过 openSession 保留 fromAgent', async () => {
    useBrowserSessionStore.setState({ ...INITIAL_BROWSER_SESSION_STATE });

    const first = useBrowserSessionStore
      .getState()
      .navigate('https://example.com/new', { forceUserControl: false, fromAgent: true });
    const duplicate = useBrowserSessionStore
      .getState()
      .navigate('https://example.com/new', { forceUserControl: false, fromAgent: true });
    await Promise.all([first, duplicate]);

    expect(takeOverApi).not.toHaveBeenCalled();
    expect(openSessionApi).toHaveBeenCalledTimes(1);
    expect(openSessionApi).toHaveBeenCalledWith('https://example.com/new', {
      fromAgent: true,
    });
  });

  it('导航开始后忽略迟到的初始 hydrate 快照', async () => {
    useBrowserSessionStore.setState({ ...INITIAL_BROWSER_SESSION_STATE });
    let resolveHydrate!: (value: unknown) => void;
    getStateApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydrate = resolve;
        }),
    );

    const hydration = useBrowserSessionStore.getState().hydrateFromRust();
    await useBrowserSessionStore
      .getState()
      .navigate('https://example.com/new', { forceUserControl: false, fromAgent: true });
    resolveHydrate({
      sessionId: 'stale',
      currentUrl: 'https://stale.example',
      controlMode: 'user',
    });
    await hydration;

    expect(useBrowserSessionStore.getState().sessionId).toBe('s-new');
    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://example.com/new');
  });

  it('关闭会等待正在创建的 session，再按真实 sessionId 清理', async () => {
    useBrowserSessionStore.setState({ ...INITIAL_BROWSER_SESSION_STATE });
    let resolveOpen!: (value: Awaited<ReturnType<typeof openSessionApi>>) => void;
    openSessionApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );

    const navigation = useBrowserSessionStore
      .getState()
      .navigate('https://example.com/new', { forceUserControl: false, fromAgent: true });
    const closing = useBrowserSessionStore.getState().closeSession();
    expect(closeSessionApi).not.toHaveBeenCalled();

    resolveOpen({
      sessionId: 's-new',
      currentUrl: 'https://example.com/new',
      title: 'New',
      canGoBack: false,
      canGoForward: false,
      controlMode: 'agent',
      loading: false,
      history: [{ url: 'https://example.com/new', title: 'New' }],
      historyIndex: 0,
      agentAutomationSupported: true,
      error: null,
    });
    await Promise.all([navigation, closing]);

    expect(closeSessionApi).toHaveBeenCalledWith('s-new');
    expect(useBrowserSessionStore.getState().sessionId).toBeNull();
  });

  it('不同 key 的 busy 导航不会覆盖真实在途请求，关闭仍等待首个 session', async () => {
    useBrowserSessionStore.setState({ ...INITIAL_BROWSER_SESSION_STATE });
    let resolveOpen!: (value: Awaited<ReturnType<typeof openSessionApi>>) => void;
    openSessionApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );

    const firstNavigation = useBrowserSessionStore
      .getState()
      .navigate('https://example.com/a', { forceUserControl: false, fromAgent: true });
    const rejectedNavigation = useBrowserSessionStore
      .getState()
      .navigate('https://example.com/b', { forceUserControl: false, fromAgent: true });
    await expect(rejectedNavigation).rejects.toMatchObject({ code: 'BROWSER_BUSY' });

    const closing = useBrowserSessionStore.getState().closeSession();
    expect(closeSessionApi).not.toHaveBeenCalled();

    resolveOpen({
      sessionId: 's-from-first-navigation',
      currentUrl: 'https://example.com/a',
      title: 'A',
      canGoBack: false,
      canGoForward: false,
      controlMode: 'agent',
      loading: false,
      history: [{ url: 'https://example.com/a', title: 'A' }],
      historyIndex: 0,
      agentAutomationSupported: true,
      error: null,
    });
    await Promise.all([firstNavigation, closing]);

    expect(openSessionApi).toHaveBeenCalledTimes(1);
    expect(closeSessionApi).toHaveBeenCalledWith('s-from-first-navigation');
    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: null,
      currentUrl: '',
      contentVisible: false,
      loading: false,
    });
  });

  it('pending Y 不会被旧 X 的迟到 closed 事件取消', async () => {
    useBrowserSessionStore.setState({ ...INITIAL_BROWSER_SESSION_STATE });
    let resolveOpen!: (value: Awaited<ReturnType<typeof openSessionApi>>) => void;
    openSessionApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );

    const navigation = useBrowserSessionStore
      .getState()
      .navigate('https://y.example', { forceUserControl: false, fromAgent: true });
    __applyClosedPayloadForTest({ sessionId: 'old-session-x', reason: 'destroyed' });
    resolveOpen({
      sessionId: 'new-session-y',
      currentUrl: 'https://y.example',
      title: 'Y',
      canGoBack: false,
      canGoForward: false,
      controlMode: 'agent',
      loading: false,
      history: [{ url: 'https://y.example', title: 'Y' }],
      historyIndex: 0,
      agentAutomationSupported: true,
      error: null,
    });
    await navigation;

    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: 'new-session-y',
      currentUrl: 'https://y.example',
      controlMode: 'agent',
      loading: false,
    });
  });

  it('pending Y 若已收到自身 closed，迟到 open 回执不会复活它', async () => {
    useBrowserSessionStore.setState({ ...INITIAL_BROWSER_SESSION_STATE });
    let resolveOpen!: (value: Awaited<ReturnType<typeof openSessionApi>>) => void;
    openSessionApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );

    const navigation = useBrowserSessionStore
      .getState()
      .navigate('https://y.example', { forceUserControl: false, fromAgent: true });
    __applyClosedPayloadForTest({ sessionId: 'new-session-y', reason: 'destroyed' });
    resolveOpen({
      sessionId: 'new-session-y',
      currentUrl: 'https://y.example',
      title: 'Y',
      canGoBack: false,
      canGoForward: false,
      controlMode: 'agent',
      loading: false,
      history: [{ url: 'https://y.example', title: 'Y' }],
      historyIndex: 0,
      agentAutomationSupported: true,
      error: null,
    });
    await navigation;

    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: null,
      currentUrl: '',
      contentVisible: false,
      loading: false,
    });
  });
});
