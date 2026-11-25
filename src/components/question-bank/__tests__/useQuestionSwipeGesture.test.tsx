import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startsInHorizontalScrollable,
  useQuestionSwipeGesture,
  type UseQuestionSwipeGestureOptions,
} from '../useQuestionSwipeGesture';

function createContainer(clientWidth: number): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: clientWidth,
  });
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useQuestionSwipeGesture', () => {
  it('computes settingsPanelWidth with 280px floor and base translate for open/closed states', () => {
    const narrowContainer = createContainer(320);
    const onChange = vi.fn();

    const { result, rerender } = renderHook(
      (props: UseQuestionSwipeGestureOptions) => useQuestionSwipeGesture(props),
      {
        initialProps: {
          containerRef: { current: narrowContainer },
          isSmallScreen: true,
          showSettingsPanel: false,
          onShowSettingsPanelChange: onChange,
        },
      },
    );

    // 320 - 60 = 260 -> clamped to 280
    expect(result.current.containerWidth).toBe(320);
    expect(result.current.settingsPanelWidth).toBe(280);
    expect(result.current.getBaseTranslate()).toBe(0);

    rerender({
      containerRef: { current: narrowContainer },
      isSmallScreen: true,
      showSettingsPanel: true,
      onShowSettingsPanelChange: onChange,
    });
    expect(result.current.getBaseTranslate()).toBe(-280);

    const wideContainer = createContainer(420);
    rerender({
      containerRef: { current: wideContainer },
      isSmallScreen: true,
      showSettingsPanel: true,
      onShowSettingsPanelChange: onChange,
    });
    // 420 - 60 = 360
    expect(result.current.settingsPanelWidth).toBe(360);
    expect(result.current.getBaseTranslate()).toBe(-360);
  });

  it('opens settings panel on left swipe past 30% threshold and ignores short swipes', () => {
    const container = createContainer(400); // settingsPanelWidth = 340, 30% = 102
    const onChange = vi.fn();

    const { result } = renderHook(() =>
      useQuestionSwipeGesture({
        containerRef: { current: container },
        isSmallScreen: true,
        showSettingsPanel: false,
        onShowSettingsPanelChange: onChange,
      }),
    );

    const preventDefault = vi.fn();
    // Short swipe (-60px < 102px) should not open panel
    act(() => {
      result.current.handleDragStart(300, 100);
      result.current.handleDragMove(240, 102, preventDefault);
      result.current.handleDragEnd();
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);
    expect(result.current.dragOffset).toBe(0);

    // Long swipe (-150px > 102px) opens panel
    act(() => {
      result.current.handleDragStart(300, 100);
      result.current.handleDragMove(150, 105, preventDefault);
    });
    expect(result.current.isDragging).toBe(true);
    expect(result.current.dragOffset).toBe(-150);

    act(() => {
      result.current.handleDragEnd();
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(result.current.isDragging).toBe(false);
    expect(result.current.dragOffset).toBe(0);
  });

  it('closes settings panel on right swipe past 30% threshold', () => {
    const container = createContainer(400); // settingsPanelWidth = 340, 30% = 102
    const onChange = vi.fn();

    const { result } = renderHook(() =>
      useQuestionSwipeGesture({
        containerRef: { current: container },
        isSmallScreen: true,
        showSettingsPanel: true,
        onShowSettingsPanelChange: onChange,
      }),
    );

    const preventDefault = vi.fn();
    act(() => {
      result.current.handleDragStart(50, 100);
      result.current.handleDragMove(200, 105, preventDefault);
      result.current.handleDragEnd();
    });

    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('aborts horizontal drag when initial motion locks to vertical scroll', () => {
    const container = createContainer(400);
    const onChange = vi.fn();

    const { result } = renderHook(() =>
      useQuestionSwipeGesture({
        containerRef: { current: container },
        isSmallScreen: true,
        showSettingsPanel: false,
        onShowSettingsPanelChange: onChange,
      }),
    );

    const preventDefault = vi.fn();
    act(() => {
      result.current.handleDragStart(200, 100);
      // Vertical movement dominates (deltaY = 30, deltaX = -12)
      result.current.handleDragMove(188, 130, preventDefault);
      // Subsequent horizontal motion must stay ignored
      result.current.handleDragMove(20, 130, preventDefault);
      result.current.handleDragEnd();
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);
    expect(result.current.dragOffset).toBe(0);
  });

  it('detects horizontally scrollable ancestors to avoid hijacking table/math scrolling', () => {
    const container = createContainer(375);
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'auto';
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 520 });
    const innerCell = document.createElement('span');
    scroller.appendChild(innerCell);
    container.appendChild(scroller);

    expect(startsInHorizontalScrollable(innerCell, container)).toBe(true);

    const nonScrollable = document.createElement('div');
    nonScrollable.style.overflowX = 'visible';
    Object.defineProperty(nonScrollable, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(nonScrollable, 'scrollWidth', { configurable: true, value: 300 });
    container.appendChild(nonScrollable);

    expect(startsInHorizontalScrollable(nonScrollable, container)).toBe(false);
    expect(startsInHorizontalScrollable(null, container)).toBe(false);
  });
});
