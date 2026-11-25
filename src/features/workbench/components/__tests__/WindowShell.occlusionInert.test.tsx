import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { WorkbenchWindow } from '../../core/types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../WindowTitleBar', () => ({
  TITLEBAR_HEIGHT: 36,
  WindowTitleBar: ({ title }: { title: string }) => <div data-testid="titlebar">{title}</div>,
}));

vi.mock('../WindowResizeHandles', () => ({
  WindowResizeHandles: () => null,
}));

vi.mock('../WindowBody', () => ({
  WindowBody: () => null,
}));

vi.mock('../../agent/presenceStore', () => ({
  useWindowPresence: () => null,
}));

vi.mock('../../agent/visuals/AgentStrip', () => ({
  AgentStrip: () => null,
}));

vi.mock('../../core/nativeSurfaceEvents', () => ({
  resumeAllNativeSurfaces: vi.fn(),
  resumeNativeSurface: vi.fn(),
  suspendAllNativeSurfaces: vi.fn(),
  syncNativeSurface: vi.fn(),
  suspendNativeSurface: vi.fn(),
}));

import { useWindowStore } from '../../core/windowStore';
import { WindowShell } from '../WindowShell';

function makeWindow(overrides: Partial<WorkbenchWindow> & Pick<WorkbenchWindow, 'id'>): WorkbenchWindow {
  return {
    typeId: 'todo',
    title: overrides.id,
    frame: { x: 40, y: 40, w: 600, h: 480 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 10,
    lifecycle: 'active',
    lastActiveAt: Date.now(),
    ...overrides,
  };
}

describe('WindowShell Stage occlusion inert/aria-hidden (G12)', () => {
  beforeEach(() => {
    useWindowStore.setState({
      windows: {},
      focusStack: [],
      desktopSize: { w: 1280, h: 800 },
      tilingRatios: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('marks background windows inert and aria-hidden when occluded by a higher-zIndex maximized foreground window, and blurs trapped focus', () => {
    const bgWin = makeWindow({ id: 'win_bg', title: 'Notes', displayMode: 'floating', zIndex: 10 });
    const fgWin = makeWindow({ id: 'win_fg', title: 'Todo', displayMode: 'floating', zIndex: 20 });

    useWindowStore.setState({
      windows: { [bgWin.id]: bgWin, [fgWin.id]: fgWin },
      focusStack: [bgWin.id, fgWin.id],
    });

    const { container } = render(
      <>
        <WindowShell windowId={bgWin.id}>
          <button type="button" data-testid="bg-action">
            Background Button
          </button>
        </WindowShell>
        <WindowShell windowId={fgWin.id}>
          <button type="button" data-testid="fg-action">
            Foreground Button
          </button>
        </WindowShell>
      </>,
    );

    const bgSection = container.querySelector<HTMLElement>('[data-window-id="win_bg"]')!;
    const fgSection = container.querySelector<HTMLElement>('[data-window-id="win_fg"]')!;
    const bgButton = screen.getByTestId('bg-action');

    // Both floating: neither window is occluded
    expect(bgSection.hasAttribute('inert')).toBe(false);
    expect(bgSection.getAttribute('aria-hidden')).toBeNull();
    expect(bgSection.dataset.occluded).toBeUndefined();

    // Focus a control inside the background window before maximizing the foreground window
    bgButton.focus();
    expect(document.activeElement).toBe(bgButton);

    // Maximizing the foreground window above win_bg must prune win_bg from the a11y tree & Tab order
    act(() => {
      useWindowStore.setState((s) => ({
        windows: {
          ...s.windows,
          [fgWin.id]: { ...s.windows[fgWin.id]!, displayMode: 'maximized' },
        },
      }));
    });

    expect(bgSection.inert).toBe(true);
    expect(bgSection.hasAttribute('inert')).toBe(true);
    expect(bgSection.getAttribute('aria-hidden')).toBe('true');
    expect(bgSection.dataset.occluded).toBe('true');
    expect(document.activeElement).not.toBe(bgButton);

    // The foreground maximized window itself stays interactive
    expect(fgSection.inert).toBe(false);
    expect(fgSection.hasAttribute('inert')).toBe(false);
    expect(fgSection.getAttribute('aria-hidden')).toBeNull();

    // Minimizing the foreground window restores background window interactivity
    act(() => {
      useWindowStore.setState((s) => ({
        windows: {
          ...s.windows,
          [fgWin.id]: { ...s.windows[fgWin.id]!, minimized: true },
        },
        focusStack: [bgWin.id],
      }));
    });

    expect(bgSection.inert).toBe(false);
    expect(bgSection.hasAttribute('inert')).toBe(false);
    expect(bgSection.getAttribute('aria-hidden')).toBeNull();
    expect(bgSection.dataset.occluded).toBeUndefined();
    expect(fgSection.inert).toBe(true);
    expect(fgSection.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps side-by-side tiled windows interactive and updates occlusion when z-order swaps between two maximized windows', () => {
    const leftWin = makeWindow({ id: 'win_left', displayMode: 'tiled-left', zIndex: 10 });
    const rightWin = makeWindow({ id: 'win_right', displayMode: 'tiled-right', zIndex: 20 });

    useWindowStore.setState({
      windows: { [leftWin.id]: leftWin, [rightWin.id]: rightWin },
      focusStack: [leftWin.id, rightWin.id],
    });

    const { container } = render(
      <>
        <WindowShell windowId={leftWin.id}>
          <button type="button">Left</button>
        </WindowShell>
        <WindowShell windowId={rightWin.id}>
          <button type="button">Right</button>
        </WindowShell>
      </>,
    );

    const leftSection = container.querySelector<HTMLElement>('[data-window-id="win_left"]')!;
    const rightSection = container.querySelector<HTMLElement>('[data-window-id="win_right"]')!;

    // Split tiled windows must NEVER occlude each other
    expect(leftSection.hasAttribute('inert')).toBe(false);
    expect(leftSection.getAttribute('aria-hidden')).toBeNull();
    expect(rightSection.hasAttribute('inert')).toBe(false);
    expect(rightSection.getAttribute('aria-hidden')).toBeNull();

    // Maximize both: lower-zIndex becomes occluded; raising it flips occlusion cleanly
    act(() => {
      useWindowStore.setState((s) => ({
        windows: {
          [leftWin.id]: { ...s.windows[leftWin.id]!, displayMode: 'maximized', zIndex: 10 },
          [rightWin.id]: { ...s.windows[rightWin.id]!, displayMode: 'maximized', zIndex: 20 },
        },
        focusStack: [leftWin.id, rightWin.id],
      }));
    });

    expect(leftSection.hasAttribute('inert')).toBe(true);
    expect(leftSection.getAttribute('aria-hidden')).toBe('true');
    expect(rightSection.hasAttribute('inert')).toBe(false);
    expect(rightSection.getAttribute('aria-hidden')).toBeNull();

    act(() => {
      useWindowStore.setState((s) => ({
        windows: {
          [leftWin.id]: { ...s.windows[leftWin.id]!, zIndex: 30 },
          [rightWin.id]: { ...s.windows[rightWin.id]!, zIndex: 20 },
        },
        focusStack: [rightWin.id, leftWin.id],
      }));
    });

    expect(leftSection.hasAttribute('inert')).toBe(false);
    expect(leftSection.getAttribute('aria-hidden')).toBeNull();
    expect(rightSection.hasAttribute('inert')).toBe(true);
    expect(rightSection.getAttribute('aria-hidden')).toBe('true');
  });
});
