/**
 * Browser app 注册冒烟（B2b）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  sessionId: 'bs_1' as string | null,
  currentUrl: 'https://example.com',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  controlMode: 'user' as const,
  loading: false,
  history: [],
  historyIndex: 0,
  agentAutomationSupported: true,
  error: null,
  contentVisible: true,
  tabs: [
    { tabId: 't1', url: 'https://example.com', title: 'Example', active: true },
    { tabId: 't2', url: 'https://docs.example.com', title: 'Docs', active: false },
  ],
  activeTabId: 't1' as string | null,
  navigate: vi.fn(async () => undefined),
  takeOver: vi.fn(async () => undefined),
  showContent: vi.fn(async () => true),
  closeSession: vi.fn(async () => undefined),
  createTab: vi.fn(async () => undefined),
  switchTab: vi.fn(async () => undefined),
  closeTab: vi.fn(async () => undefined),
  extractCurrentPage: vi.fn(async () => ({
    url: 'https://example.com',
    title: 'Example',
    markdown: '# Example\n\nContent',
    totalChars: 18,
    truncated: false,
  })),
}));

vi.mock('@/features/browser/sessionStore', () => ({
  useBrowserSessionStore: {
    getState: () => mockState,
  },
  getBrowserSessionState: () => mockState,
}));

import { appRegistry } from '../../../core/appRegistry';
import {
  BROWSER_APP_TYPE_ID,
  handleBrowserActivation,
  registerBrowserApp,
} from '../register';

describe('registerBrowserApp', () => {
  beforeEach(() => {
    mockState.navigate.mockClear();
    mockState.takeOver.mockClear();
    mockState.showContent.mockClear();
    mockState.closeSession.mockClear();
    mockState.createTab.mockClear();
    mockState.switchTab.mockClear();
    mockState.closeTab.mockClear();
    mockState.extractCurrentPage.mockClear();
    registerBrowserApp();
  });

  it('注册 typeId=browser、single、920×600、memoryWeight=2', () => {
    const def = appRegistry.get(BROWSER_APP_TYPE_ID);
    expect(def).toBeTruthy();
    expect(def?.instanceMode).toBe('single');
    expect(def?.memoryWeight).toBe(2);
    expect(def?.defaultFrame).toEqual({ w: 920, h: 600 });
    expect(def?.minSize).toEqual({ w: 640, h: 420 });
    expect(def?.onActivation).toBeTypeOf('function');
    expect(def?.canClose).toBeTypeOf('function');
    expect(def?.render).toBeTruthy();
  });

  it('onActivation 分发 navigate / takeOver / showContent', async () => {
    await handleBrowserActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'navigate',
      payload: { url: 'https://example.com' },
    });
    await handleBrowserActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'takeOver',
    });
    await handleBrowserActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'showContent',
    });

    expect(mockState.navigate).toHaveBeenCalledWith('https://example.com', {
      forceUserControl: false,
      fromAgent: true,
    });
    expect(mockState.takeOver).toHaveBeenCalledTimes(1);
    expect(mockState.showContent).toHaveBeenCalledTimes(1);
  });

  it('onActivation await 后端真实结果并返回失败回执', async () => {
    let rejectNavigate!: (reason: unknown) => void;
    mockState.navigate.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => {
        rejectNavigate = reject;
      }),
    );
    const pending = handleBrowserActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'navigate',
      payload: { url: 'https://example.com' },
    });
    rejectNavigate(new Error('NAVIGATION_BLOCKED: private network'));
    await expect(pending).resolves.toMatchObject({
      handled: false,
      code: 'BROWSER_ACTION_FAILED',
      message: 'NAVIGATION_BLOCKED: private network',
    });
  });

  it('canClose 放行动画，native session 由窗口卸载后清理', async () => {
    const def = appRegistry.get(BROWSER_APP_TYPE_ID);
    const ok = await def!.canClose!(null);
    expect(ok).toBe(true);
    expect(mockState.closeSession).not.toHaveBeenCalled();
  });

  it('onActivation 分发 newTab / switchTab / closeTab / extractContent 并校验参数', async () => {
    await expect(
      handleBrowserActivation({
        windowId: 'w1',
        instanceKey: null,
        action: 'newTab',
        payload: { url: 'https://example.org' },
      }),
    ).resolves.toMatchObject({ handled: true, acknowledged: true });
    expect(mockState.createTab).toHaveBeenCalledWith('https://example.org');

    await expect(
      handleBrowserActivation({
        windowId: 'w1',
        instanceKey: null,
        action: 'switchTab',
        payload: { tabId: 't2' },
      }),
    ).resolves.toMatchObject({ handled: true, acknowledged: true });
    expect(mockState.switchTab).toHaveBeenCalledWith('t2');

    await expect(
      handleBrowserActivation({
        windowId: 'w1',
        instanceKey: null,
        action: 'closeTab',
        payload: { tabId: 't2' },
      }),
    ).resolves.toMatchObject({ handled: true, acknowledged: true });
    expect(mockState.closeTab).toHaveBeenCalledWith('t2');

    await expect(
      handleBrowserActivation({
        windowId: 'w1',
        instanceKey: null,
        action: 'switchTab',
        payload: {},
      }),
    ).resolves.toMatchObject({ handled: false, code: 'INVALID_ARGS' });

    await expect(
      handleBrowserActivation({
        windowId: 'w1',
        instanceKey: null,
        action: 'extractContent',
        payload: { maxChars: 2000 },
      }),
    ).resolves.toMatchObject({
      handled: true,
      acknowledged: true,
      message: '# Example\n\nContent',
    });
    expect(mockState.extractCurrentPage).toHaveBeenCalledWith({ maxChars: 2000 });
  });

  it('agentManifest 暴露多标签与正文提取能力及观测状态', async () => {
    const def = appRegistry.get(BROWSER_APP_TYPE_ID);
    const manifest = def?.agentManifest;
    expect(manifest).toBeTruthy();
    expect(manifest!.capabilities.map((c) => c.name)).toEqual(
      expect.arrayContaining(['newTab', 'switchTab', 'closeTab', 'extractContent']),
    );

    const obs = await manifest!.observe!({
      windowId: 'w1',
      typeId: BROWSER_APP_TYPE_ID,
      instanceKey: null,
    });
    expect(obs.availableActions).toEqual(
      expect.arrayContaining(['newTab', 'switchTab', 'closeTab', 'extractContent']),
    );
    expect(obs.state).toMatchObject({
      activeTabId: 't1',
      tabCount: 2,
      tabs: [
        { tabId: 't1', url: 'https://example.com', title: 'Example', active: true },
        { tabId: 't2', url: 'https://docs.example.com', title: 'Docs', active: false },
      ],
    });
  });
});
