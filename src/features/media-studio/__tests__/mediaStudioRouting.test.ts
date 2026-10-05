/**
 * 音视频子应用的入口与路由：
 * - openMediaStudio：经典壳切到 'media' 视图 / 学习桌面开「音视频」窗口，学习页资源进共享 store；
 * - 视图别名、学习桌面降级映射、命令面板入口；
 * - `[媒体@…]` 引用（聊天页之外）→ 学习页 + 只投给子应用播放器的 seek 握手（App.tsx 源码契约 +
 *   focus 作用域过滤 + 待兑现意图兜底）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({
  enabled: false,
  launch: vi.fn(),
  registerLegacyFallback: vi.fn(),
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: {
    isEnabled: () => bus.enabled,
    launch: bus.launch,
    registerLegacyFallback: bus.registerLegacyFallback,
  },
}));
vi.mock('@/features/workbench/core/windowStore', () => ({
  useWindowStore: { getState: () => ({ windows: {}, focusStack: [] }) },
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import {
  MEDIA_STUDIO_FOCUS_SCOPE,
  mediaStudioPayloadResourceId,
  openMediaStudio,
  useMediaStudioNavStore,
} from '../mediaStudioNavigation';
import { canonicalizeView, isSupportedView } from '@/app/navigation/canonicalView';
import { translateLegacyNavigation } from '@/features/workbench/core/legacyNavigationMap';
import { getNavigationCommands } from '@/command-palette/modules/navigation.commands';
import { useMediaFocusListener } from '@/features/learning-hub/apps/views/media/useMediaFocusListener';
import {
  dispatchOpenMediaRef,
  requestMediaFocusUntilHandled,
  takePendingMediaFocus,
} from '@/features/learning-hub/apps/views/media/mediaRefEvents';

describe('openMediaStudio', () => {
  let navigations: unknown[];
  const onNavigate = (event: Event) => navigations.push((event as CustomEvent).detail);

  beforeEach(() => {
    navigations = [];
    bus.enabled = false;
    window.addEventListener('NAVIGATE_TO_VIEW', onNavigate);
    useMediaStudioNavStore.setState({ activeResourceId: null, openSeq: 0 });
  });
  afterEach(() => {
    window.removeEventListener('NAVIGATE_TO_VIEW', onNavigate);
    vi.clearAllMocks();
  });

  it('classic shell: opens the study page for the resource and switches to the media view', () => {
    openMediaStudio('/file_lecture');
    expect(useMediaStudioNavStore.getState().activeResourceId).toBe('file_lecture');
    expect(navigations).toEqual([{ view: 'media' }]);
    expect(bus.launch).not.toHaveBeenCalled();
  });

  it('without a resource goes to the library page', () => {
    useMediaStudioNavStore.getState().openStudy('file_x');
    openMediaStudio();
    expect(useMediaStudioNavStore.getState().activeResourceId).toBeNull();
    expect(navigations).toEqual([{ view: 'media' }]);
  });

  it('learning desktop: launches the Media window with the resource payload', () => {
    bus.enabled = true;
    openMediaStudio('file_lecture');
    expect(bus.launch).toHaveBeenCalledWith({ typeId: 'media', payload: { resourceId: 'file_lecture' }, reason: 'api' });
    expect(navigations).toEqual([]);
    expect(mediaStudioPayloadResourceId({ resourceId: ' /file_lecture ' })).toBe('file_lecture');
    expect(mediaStudioPayloadResourceId(null)).toBeNull();
  });
});

describe('navigation registration', () => {
  it('media is a canonical view with legacy aliases', () => {
    expect(isSupportedView('media')).toBe(true);
    expect(canonicalizeView('media-studio')).toBe('media');
    expect(canonicalizeView('audio-video')).toBe('media');
  });

  it('workbench launch of the media app falls back to the classic media view', () => {
    const navigations: unknown[] = [];
    const listener = (event: Event) => navigations.push((event as CustomEvent).detail);
    window.addEventListener('NAVIGATE_TO_VIEW', listener);
    translateLegacyNavigation({ typeId: 'media', reason: 'dock' }, 'launch');
    window.removeEventListener('NAVIGATE_TO_VIEW', listener);
    expect(navigations).toEqual([expect.objectContaining({ view: 'media' })]);
  });

  it('command palette has a Go to Media command', () => {
    const command = getNavigationCommands().find((c) => c.id === 'nav.goto.media');
    expect(command).toBeDefined();
    const navigate = vi.fn();
    void command!.execute({ navigate } as never);
    expect(navigate).toHaveBeenCalledWith('media');
  });
});

describe('[媒体@…] citation routing', () => {
  it('App routes non-chat media-ref:open to the studio study page with a scoped seek', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
    const handler = app.slice(app.indexOf('const handleMediaRefOpen'), app.indexOf("type: 'media-ref:open'"));
    expect(handler).toContain("currentViewRef.current === 'chat-v2'");
    expect(handler).toContain('openMediaStudio(resourceId)');
    expect(handler).toContain('targetScopeId: MEDIA_STUDIO_FOCUS_SCOPE');
    expect(handler).not.toContain('LEARNING_HUB_OPEN_RESOURCE');
  });

  it('scoped focus reaches only the studio player, not a kept-alive library tab of the same media', () => {
    vi.useFakeTimers();
    const node = { nodeId: 'file_lecture' };
    const studio = renderHook(() =>
      useMediaFocusListener({ enabled: true, focusScopeId: MEDIA_STUDIO_FOCUS_SCOPE, ...node }),
    );
    const library = renderHook(() => useMediaFocusListener({ enabled: true, ...node }));

    let cancel: () => void = () => undefined;
    act(() => {
      cancel = requestMediaFocusUntilHandled({ resourceId: 'file_lecture', seconds: 75, targetScopeId: MEDIA_STUDIO_FOCUS_SCOPE });
      vi.advanceTimersByTime(0);
    });
    expect(studio.result.current[0]).toMatchObject({ seconds: 75 });
    expect(library.result.current[0]).toBeNull();

    // 学习页兑现后回执，停止重发
    act(() => studio.result.current[1](studio.result.current[0]!.requestId, true));
    act(() => { vi.advanceTimersByTime(6000); });
    expect(studio.result.current[0]).toBeNull();
    cancel();
    vi.useRealTimers();
  });

  it('remembers the seek as a pending intent for a cold-start study page', () => {
    const listener = vi.fn();
    document.addEventListener('media-ref:open', listener);
    dispatchOpenMediaRef('file_lecture', 42);
    document.removeEventListener('media-ref:open', listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takePendingMediaFocus((id) => id === 'file_other')).toBeNull();
    expect(takePendingMediaFocus((id) => id === 'file_lecture')).toBe(42);
    expect(takePendingMediaFocus(() => true)).toBeNull();
  });
});
