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
});
