/**
 * S4-17 (Round 6 Retry): 360px Mobile Dock collapsed reveal handle
 *
 * Ensures the collapsed mobile Dock handle ("程序坞已自动收起…点击此处即可唤出"):
 * - Has a dedicated, centered, unobstructed 40px touch target with high z-index
 *   strictly above Chat's composer and bottom-left "+" attachment button;
 * - Calls stopPropagation() + preventDefault() on touch/pointer/click so taps
 *   never fall through to the "+" attachment menu;
 * - Reliably opens the Mobile Dock on the very first single tap (touchEnd,
 *   pointerUp[touch], click, or keyboard Enter/Space);
 * - Synchronously updates data-wb-dock-revealed, --wb-mobile-dock-clearance,
 *   data-wb-dock-collapsed, and --wb-mobile-dock-handle-clearance.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { AppDefinition, AppWindowProps } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
import { Dock, MOBILE_DOCK_HANDLE_CLEARANCE_PX } from '../Dock';
import { setDockPinned } from '../DockPinnedStore';
import { closeAppsPanel } from '../appsPanelStore';
import { resetDockMagnificationForTests } from '../../core/dockMagnificationStore';
import { AGENT_CONTROL_DISCOVERY_SEEN_KEY } from '../AgentControlCenter';

const NullApp: React.FC<AppWindowProps> = () => null;

function makeApp(typeId: string, over?: Partial<AppDefinition>): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:app.${typeId}`,
    icon: <span data-testid={`icon-${typeId}`}>{typeId[0]}</span>,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 360, h: 760 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({ default: NullApp })),
    ...over,
  };
}

function createPointerEvent(
  type: 'pointerenter' | 'pointerdown' | 'pointerup' | 'pointerleave',
  pointerType: 'touch' | 'pen' | 'mouse',
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: type !== 'pointerenter' && type !== 'pointerleave',
    cancelable: true,
    clientX: 180,
    clientY: 784,
  });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

describe('Dock 360px Mobile Reveal Handle (S4-17 Round 6 Retry)', () => {
  let origMatchMedia: typeof window.matchMedia;
  let origInnerWidth: number;

  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    workbenchBus.setEnabled(true);
    if (!appRegistry.get('chat')) appRegistry.register(makeApp('chat'));
    if (!appRegistry.get('files')) appRegistry.register(makeApp('files', { instanceMode: 'single' }));
  });

  beforeEach(() => {
    origMatchMedia = window.matchMedia;
    origInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 360,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 767px') || query.includes('max-width: 640px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    useWindowStore.setState({
      windows: {},
      focusStack: [],
      lifecycles: {},
      launchPayloads: {},
      tilingRatios: {},
      desktopSize: { w: 360, h: 760 },
    });
    setDockPinned(['chat', 'files']);
    closeAppsPanel();
    resetDockMagnificationForTests();
    localStorage.removeItem(AGENT_CONTROL_DISCOVERY_SEEN_KEY);
    sessionStorage.removeItem('wb.dock.compactCollapsed');
    sessionStorage.removeItem('ds.workbench.activeSession');
    useWindowStore.getState().openWindow({ typeId: 'chat', instanceKey: 'mobile-chat', title: '对话' });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: origInnerWidth,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: origMatchMedia,
    });
  });

  it('renders a dedicated high-z-index, touch-friendly 40px mobile reveal button and reserves collapsed handle clearance', () => {
    const { unmount } = render(
      <div data-wb-workbench-root="" data-testid="wb-root">
        <div data-wb-desktop="" data-testid="wb-desktop">
          <div data-wb-window-layer="" data-testid="wb-window-layer" />
          <Dock />
        </div>
      </div>,
    );

    const root = screen.getByTestId('wb-root');
    const desktop = screen.getByTestId('wb-desktop');
    const dock = screen.getByTestId('wb-dock');
    const hotzone = screen.getByTestId('wb-dock-hotzone');
    const pill = screen.getByTestId('wb-dock-mobile-handle-pill');

    expect(dock).toHaveAttribute('data-hidden', 'true');
    expect(dock).toHaveAttribute('inert');

    // Interactive native <button> with >= 40px hit target, high z-index, pointer-events: auto, touch-action: manipulation
    expect(hotzone.tagName).toBe('BUTTON');
    expect(hotzone).toHaveAttribute('type', 'button');
    expect(hotzone).toHaveAttribute('data-collapsed', 'true');
    expect(hotzone).toHaveAttribute('data-mobile-handle', 'true');
    expect(hotzone).toHaveAttribute('aria-expanded', 'false');
    expect(hotzone.getAttribute('aria-label')).toContain('程序坞已自动收起');
    expect(hotzone.className).toContain('pointer-events-auto');
    expect(hotzone.className).toContain('min-h-[40px]');
    expect(hotzone.className).toContain('left-1/2');
    expect(hotzone.style.zIndex).toBe('calc(var(--wb-z-dock, 9000) + 1)');
    expect(hotzone.style.touchAction).toBe('manipulation');

    // Decorative pill does not intercept target identity (event.target stays on <button>)
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(pill.className).toContain('pointer-events-none');

    // Collapsed state keeps --wb-mobile-dock-clearance at 0px (Z10 contract) while reserving 40px handle clearance
    expect(document.documentElement).not.toHaveAttribute('data-wb-dock-revealed');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-clearance')).toBe('0px');
    expect(document.documentElement).toHaveAttribute('data-wb-dock-collapsed', 'true');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-handle-clearance')).toBe(
      `${MOBILE_DOCK_HANDLE_CLEARANCE_PX}px`,
    );
    expect(root).toHaveAttribute('data-wb-dock-collapsed', 'true');
    expect(root.style.getPropertyValue('--wb-mobile-dock-handle-clearance')).toBe(
      `${MOBILE_DOCK_HANDLE_CLEARANCE_PX}px`,
    );
    expect(desktop).toHaveAttribute('data-wb-dock-collapsed', 'true');
    expect(desktop.style.getPropertyValue('--wb-mobile-dock-handle-clearance')).toBe(
      `${MOBILE_DOCK_HANDLE_CLEARANCE_PX}px`,
    );

    // Unmount cleans up all custom properties and attributes
    unmount();
    expect(document.documentElement).not.toHaveAttribute('data-wb-dock-collapsed');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-handle-clearance')).toBe('');
  });

  it('opens Mobile Dock on first single touch tap without falling through to underlying "+" attachment menu, and ignores trailing touch leave/click', () => {
    vi.useFakeTimers();
    const onUnderlyingTouchStart = vi.fn();
    const onUnderlyingTouchEnd = vi.fn();
    const onUnderlyingPointerDown = vi.fn();
    const onUnderlyingPointerUp = vi.fn();
    const onUnderlyingClick = vi.fn();
    const onMobileClearanceChange = vi.fn();

    render(
      <div
        data-wb-workbench-root=""
        data-testid="wb-root"
        onTouchStart={onUnderlyingTouchStart}
        onTouchEnd={onUnderlyingTouchEnd}
        onPointerDown={onUnderlyingPointerDown}
        onPointerUp={onUnderlyingPointerUp}
        onClick={onUnderlyingClick}
      >
        <div data-wb-desktop="" data-testid="wb-desktop">
          <div data-wb-window-layer="" data-testid="wb-window-layer">
            <button type="button" aria-label="添加与会话选项" onClick={onUnderlyingClick}>
              +
            </button>
          </div>
          <Dock onMobileClearanceChange={onMobileClearanceChange} />
        </div>
      </div>,
    );

    const root = screen.getByTestId('wb-root');
    const desktop = screen.getByTestId('wb-desktop');
    const dock = screen.getByTestId('wb-dock');
    const hotzone = screen.getByTestId('wb-dock-hotzone');
    Object.defineProperty(dock, 'offsetHeight', { configurable: true, value: 62 });

    // Full real mobile touch tap sequence
    fireEvent.touchStart(hotzone);
    fireEvent(hotzone, createPointerEvent('pointerenter', 'touch'));
    fireEvent(hotzone, createPointerEvent('pointerdown', 'touch'));
    const touchEndNotCancelled = fireEvent.touchEnd(hotzone);
    const pointerUpEvent = createPointerEvent('pointerup', 'touch');
    fireEvent(hotzone, pointerUpEvent);
    fireEvent(hotzone, createPointerEvent('pointerleave', 'touch'));
    // Browser may emit a trailing synthetic click after touchEnd
    const trailingClickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(hotzone, trailingClickEvent);

    // preventDefault & stopPropagation engaged — nothing bubbles to underlying composer / "+" wrapper
    expect(touchEndNotCancelled).toBe(false);
    expect(pointerUpEvent.defaultPrevented).toBe(true);
    expect(trailingClickEvent.defaultPrevented).toBe(true);
    expect(onUnderlyingTouchStart).not.toHaveBeenCalled();
    expect(onUnderlyingTouchEnd).not.toHaveBeenCalled();
    expect(onUnderlyingPointerDown).not.toHaveBeenCalled();
    expect(onUnderlyingPointerUp).not.toHaveBeenCalled();
    expect(onUnderlyingClick).not.toHaveBeenCalled();

    // Mobile Dock opens immediately on the first single tap and stays open even after timers elapse
    expect(dock).not.toHaveAttribute('data-hidden');
    expect(dock).not.toHaveAttribute('inert');
    expect(dock.className).toContain('pointer-events-auto');
    expect(hotzone).toHaveAttribute('data-collapsed', 'false');
    expect(hotzone).not.toHaveAttribute('data-mobile-handle');
    expect(screen.queryByTestId('wb-dock-mobile-handle-pill')).not.toBeInTheDocument();

    // Clearance attributes and CSS custom properties updated synchronously
    expect(document.documentElement).toHaveAttribute('data-wb-dock-revealed', 'true');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-clearance')).toBe('76px');
    expect(document.documentElement).not.toHaveAttribute('data-wb-dock-collapsed');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-handle-clearance')).toBe('0px');
    expect(root).toHaveAttribute('data-wb-dock-revealed', 'true');
    expect(root.style.getPropertyValue('--wb-mobile-dock-clearance')).toBe('76px');
    expect(desktop).toHaveAttribute('data-wb-dock-revealed', 'true');
    expect(desktop.style.getPropertyValue('--wb-mobile-dock-clearance')).toBe('76px');
    expect(onMobileClearanceChange).toHaveBeenLastCalledWith({ revealed: true, clearancePx: 76 });

    // Touching / scrolling inside revealed Dock must not accidentally conceal it
    fireEvent(dock, createPointerEvent('pointerenter', 'touch'));
    fireEvent(dock, createPointerEvent('pointerleave', 'touch'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(dock).not.toHaveAttribute('data-hidden');
    expect(document.documentElement).toHaveAttribute('data-wb-dock-revealed', 'true');
  });

  it('opens Mobile Dock on pointerup(touch)-only tap with stopPropagation and preventDefault', () => {
    const onParentPointerUp = vi.fn();
    const onParentPointerDown = vi.fn();

    render(
      <div
        data-wb-workbench-root=""
        onPointerDown={onParentPointerDown}
        onPointerUp={onParentPointerUp}
      >
        <div data-wb-desktop="">
          <Dock />
        </div>
      </div>,
    );

    const dock = screen.getByTestId('wb-dock');
    const hotzone = screen.getByTestId('wb-dock-hotzone');
    Object.defineProperty(dock, 'offsetHeight', { configurable: true, value: 62 });

    const down = createPointerEvent('pointerdown', 'touch');
    const up = createPointerEvent('pointerup', 'touch');
    fireEvent(hotzone, down);
    fireEvent(hotzone, up);

    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(onParentPointerDown).not.toHaveBeenCalled();
    expect(onParentPointerUp).not.toHaveBeenCalled();
    expect(dock).not.toHaveAttribute('data-hidden');
    expect(document.documentElement).toHaveAttribute('data-wb-dock-revealed', 'true');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-clearance')).toBe('76px');
  });

  it('calls stopPropagation + preventDefault on direct click, updates clearance, and restores collapsed handle clearance on dismiss', () => {
    const onParentClick = vi.fn();
    const onMobileClearanceChange = vi.fn();

    render(
      <div data-wb-workbench-root="" onClick={onParentClick}>
        <div data-wb-desktop="">
          <Dock onMobileClearanceChange={onMobileClearanceChange} />
        </div>
      </div>,
    );

    const dock = screen.getByTestId('wb-dock');
    const hotzone = screen.getByTestId('wb-dock-hotzone');
    Object.defineProperty(dock, 'offsetHeight', { configurable: true, value: 62 });

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(hotzone, clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onParentClick).not.toHaveBeenCalled();
    expect(dock).not.toHaveAttribute('data-hidden');
    expect(document.documentElement).toHaveAttribute('data-wb-dock-revealed', 'true');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-clearance')).toBe('76px');
    expect(document.documentElement).not.toHaveAttribute('data-wb-dock-collapsed');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-handle-clearance')).toBe('0px');
    expect(onMobileClearanceChange).toHaveBeenLastCalledWith({ revealed: true, clearancePx: 76 });

    // Collapse via explicit button -> synchronously restores collapsed handle clearance and zeroes revealed clearance
    fireEvent.click(screen.getByTestId('wb-dock-collapse-button'));
    expect(dock).toHaveAttribute('data-hidden', 'true');
    expect(document.documentElement).not.toHaveAttribute('data-wb-dock-revealed');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-clearance')).toBe('0px');
    expect(document.documentElement).toHaveAttribute('data-wb-dock-collapsed', 'true');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-handle-clearance')).toBe(
      `${MOBILE_DOCK_HANDLE_CLEARANCE_PX}px`,
    );
    expect(onMobileClearanceChange).toHaveBeenLastCalledWith({ revealed: false, clearancePx: 0 });
    expect(screen.getByTestId('wb-dock-mobile-handle-pill')).toBeInTheDocument();
  });

  it('opens Mobile Dock via keyboard Enter/Space on the collapsed reveal handle with stopPropagation + preventDefault', () => {
    const onParentKeyDown = vi.fn();
    render(
      <div data-wb-workbench-root="" onKeyDown={onParentKeyDown}>
        <div data-wb-desktop="">
          <Dock />
        </div>
      </div>,
    );

    const dock = screen.getByTestId('wb-dock');
    const hotzone = screen.getByTestId('wb-dock-hotzone');
    Object.defineProperty(dock, 'offsetHeight', { configurable: true, value: 62 });

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    fireEvent(hotzone, enterEvent);

    expect(enterEvent.defaultPrevented).toBe(true);
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(dock).not.toHaveAttribute('data-hidden');
    expect(document.documentElement).toHaveAttribute('data-wb-dock-revealed', 'true');
    expect(document.documentElement.style.getPropertyValue('--wb-mobile-dock-clearance')).toBe('76px');
  });

  it('enforces high-z-index, touch-action, >= 40px hit target, and collapsed handle clearance in both workbench.css and Dock.css', () => {
    const workbenchCss = readFileSync(resolve(__dirname, '../../styles/workbench.css'), 'utf8');
    const dockCss = readFileSync(resolve(__dirname, '../Dock.css'), 'utf8');

    for (const css of [workbenchCss, dockCss]) {
      expect(css).toContain(".wb-dock-hotzone[data-collapsed='true'][data-mobile-handle='true']");
      expect(css).toContain('z-index: calc(var(--wb-z-dock, 9000) + 1);');
      expect(css).toContain('min-height: 40px;');
      expect(css).toContain('pointer-events: auto;');
      expect(css).toContain('touch-action: manipulation;');
      expect(css).toContain("[data-wb-desktop][data-wb-dock-collapsed='true'] > [data-wb-window-layer]");
      expect(css).toContain('var(--wb-mobile-dock-handle-clearance, 40px)');
    }
  });
});
