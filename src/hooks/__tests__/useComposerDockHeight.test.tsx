/**
 * 输入栏停靠高度契约：输入栏发布到 useComposerDockHeight，不再写 document root 的自定义属性
 * （root 变量被全文档继承，每次高度变化都整页重算样式）；番茄钟药丸经订阅拿到同一高度。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { InputBarUI } from '@/features/chat/components/input-bar/InputBarUI';
import { createDefaultPanelStates } from '@/features/chat/core/types/common';
import { GlobalPomodoroWidget } from '@/features/pomodoro/components/GlobalPomodoroWidget';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';
import { useViewStore } from '@/stores/viewStore';
import { getComposerDockHeight, setComposerDockHeight } from '../useComposerDockHeight';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({ isDragging: false, dropZoneProps: {} }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({ isMobile: false, isFullscreenContent: false }),
}));

const ROOT_VARS = ['--composer-dock-height', '--unified-input-docked-height', '--unified-input-keyboard-inset'];
const PILL_MAIN_LABEL = 'pomodoro.controls.enterImmersive';

function renderInputBar() {
  return render(
    <InputBarUI
      inputValue=""
      canSend={false}
      canAbort={false}
      isStreaming={false}
      attachments={[]}
      panelStates={createDefaultPanelStates()}
      onInputChange={vi.fn()}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      onAddAttachment={vi.fn()}
      onUpdateAttachment={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onClearAttachments={vi.fn()}
      onSetPanelState={vi.fn()}
      placeholder="输入消息"
    />,
  );
}

function stubCoarsePointer(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setComposerDockHeight(null);
  usePomodoroStore.setState({ mode: 'idle', status: 'paused', isImmersive: false });
});

describe('useComposerDockHeight', () => {
  it('输入栏挂载即发布停靠高度（与根节点 inline 变量一致），不写 document root；卸载后清空', () => {
    const { unmount } = renderInputBar();

    const published = getComposerDockHeight();
    expect(published).toMatch(/^\d+px$/);
    const bar = screen.getByTestId('input-bar-v2-root');
    expect(bar.style.getPropertyValue('--unified-input-docked-height')).toBe(published);
    for (const name of ROOT_VARS) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe('');
    }

    unmount();
    expect(getComposerDockHeight()).toBeNull();
  });

  it('触屏药丸按发布的高度避让输入栏，未发布时回退 96px', () => {
    stubCoarsePointer();
    useViewStore.setState({ currentView: 'chat-v2', previousView: null });
    usePomodoroStore.setState({
      mode: 'work',
      status: 'paused',
      timeLeft: 900,
      phaseEndsAt: null,
      phaseStartedAt: null,
      currentTaskTitle: '写论文',
      settings: { ...DEFAULT_POMODORO_SETTINGS },
      isImmersive: false,
    });

    render(<GlobalPomodoroWidget />);
    const pill = () => screen.getByLabelText(PILL_MAIN_LABEL).closest<HTMLElement>('.fixed');
    expect(pill()?.getAttribute('style')).toContain('+ 96px)');

    act(() => setComposerDockHeight('131px'));
    expect(pill()?.getAttribute('style')).toContain('+ 131px)');
  });
});
