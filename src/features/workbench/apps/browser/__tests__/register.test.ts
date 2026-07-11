/**
 * Browser app 注册冒烟（B2b）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  takeOver: vi.fn(async () => undefined),
  showContent: vi.fn(async () => true),
  closeSession: vi.fn(async () => undefined),
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
    registerBrowserApp();
  });

  it('注册 typeId=browser、single、720×280、memoryWeight=2', () => {
    const def = appRegistry.get(BROWSER_APP_TYPE_ID);
    expect(def).toBeTruthy();
    expect(def?.instanceMode).toBe('single');
    expect(def?.memoryWeight).toBe(2);
    expect(def?.defaultFrame).toEqual({ w: 720, h: 280 });
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

  it('canClose 调用 closeSession 并放行', async () => {
    const def = appRegistry.get(BROWSER_APP_TYPE_ID);
    const ok = await def!.canClose!(null);
    expect(ok).toBe(true);
    expect(mockState.closeSession).toHaveBeenCalled();
  });

  it('closeSession 失败时阻止关闭 chrome，避免遗留 native window', async () => {
    mockState.closeSession.mockRejectedValueOnce(new Error('close failed'));
    const def = appRegistry.get(BROWSER_APP_TYPE_ID);
    await expect(def!.canClose!(null)).resolves.toBe(false);
  });
});
