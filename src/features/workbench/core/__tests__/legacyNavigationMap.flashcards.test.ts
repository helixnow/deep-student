/**
 * legacyNavigationMap.flashcards — 闪卡降级映射测试（2026-09）。
 *
 * 口径：
 * - flashcards 已映射到经典壳 'flashcards' 视图：launch/activate 派发
 *   NAVIGATE_TO_VIEW，不再落入 LEGACY_NOOP「仅桌面端可用」通知；
 * - browser 仍为 no-op + 通知（回归锚点）。
 *
 * workbenchBus / 通知 / i18n 同步 mock，与 handoff.legacyRoundtrip 同口径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../windowStore', () => ({
  useWindowStore: { getState: () => ({ windows: {}, focusStack: [] }) },
}));
vi.mock('../workbenchBus', () => ({
  workbenchBus: { registerLegacyFallback: vi.fn() },
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));
vi.mock('@/utils/i18n', () => ({
  t: (key: string) => key,
}));

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { translateLegacyNavigation } from '../legacyNavigationMap';
import type { ActivateRequest, LaunchRequest } from '../types';

describe('legacyNavigationMap flashcards', () => {
  let dispatched: Array<{ name: string; detail?: unknown }>;

  beforeEach(() => {
    dispatched = [];
    vi.stubGlobal('window', {
      dispatchEvent: (event: CustomEvent) => {
        dispatched.push({ name: event.type, detail: event.detail });
        return true;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('launch flashcards navigates to the flashcards view without desktop-only notice', () => {
    const request: LaunchRequest = { typeId: 'flashcards', reason: 'dock' };
    translateLegacyNavigation(request, 'launch');

    const navigate = dispatched.find((event) => event.name === 'NAVIGATE_TO_VIEW');
    expect(navigate).toBeDefined();
    expect(navigate?.detail).toMatchObject({ view: 'flashcards' });
    expect(showGlobalNotification).not.toHaveBeenCalled();
  });

  it('activate flashcards also navigates (no-op notice removed)', () => {
    const request: ActivateRequest = {
      typeId: 'flashcards',
      instanceKey: 'flashcards',
      action: 'focus',
    };
    translateLegacyNavigation(request, 'activate');

    const navigate = dispatched.find((event) => event.name === 'NAVIGATE_TO_VIEW');
    expect(navigate?.detail).toMatchObject({ view: 'flashcards' });
    expect(showGlobalNotification).not.toHaveBeenCalled();
  });

  it('browser stays a no-op with the desktop-only notice (regression anchor)', () => {
    const request: LaunchRequest = { typeId: 'browser', reason: 'dock' };
    translateLegacyNavigation(request, 'launch');

    expect(dispatched.find((event) => event.name === 'NAVIGATE_TO_VIEW')).toBeUndefined();
    expect(showGlobalNotification).toHaveBeenCalledWith('info', expect.any(String));
  });
});
