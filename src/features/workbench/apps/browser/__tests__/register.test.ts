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
    handleBrowserActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'navigate',
      payload: { url: 'https://example.com' },
    });
    handleBrowserActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'takeOver',
    });
    handleBrowserActivation({
      windowId: 'w1',
      instanceKey: null,
      action: 'showContent',
    });

    await vi.waitFor(() => {
      expect(mockState.navigate).toHaveBeenCalledWith('https://example.com', {
        forceUserControl: false,
      });
      expect(mockState.takeOver).toHaveBeenCalledTimes(1);
      expect(mockState.showContent).toHaveBeenCalledTimes(1);
    });
  });

  it('canClose 调用 closeSession 并放行', async () => {
    const def = appRegistry.get(BROWSER_APP_TYPE_ID);
    const ok = await def!.canClose!(null);
    expect(ok).toBe(true);
    expect(mockState.closeSession).toHaveBeenCalled();
  });
});
