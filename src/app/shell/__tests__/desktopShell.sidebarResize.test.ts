import { describe, expect, it } from 'vitest';

import {
  DESKTOP_SHELL,
  getShellSidebarDragLayout,
  resolveShellSidebarResize,
} from '../desktopShell';

describe('desktop sidebar resize rules', () => {
  it('uses a roomier balanced default width', () => {
    expect(DESKTOP_SHELL.navigationWidth).toBe(320);
  });

  it('uses a larger practical free-resize range', () => {
    expect(DESKTOP_SHELL.navigationMinWidth).toBe(260);
    expect(DESKTOP_SHELL.navigationMaxWidth).toBe(480);
    expect(DESKTOP_SHELL.navigationCloseSnapWidth).toBe(180);
  });

  it('collapses at the close snap point while preserving the prior expanded width', () => {
    expect(resolveShellSidebarResize(72, 336, 1440)).toEqual({
      collapsed: true,
      width: 336,
    });

    expect(resolveShellSidebarResize(DESKTOP_SHELL.navigationCloseSnapWidth + 1, 336, 1440)).toEqual({
      collapsed: false,
      width: DESKTOP_SHELL.navigationMinWidth,
    });

    expect(resolveShellSidebarResize(200, 336, 1440)).toEqual({
      collapsed: false,
      width: DESKTOP_SHELL.navigationMinWidth,
    });
  });

  it('snaps widths near the default detent back to the default width', () => {
    expect(resolveShellSidebarResize(DESKTOP_SHELL.navigationWidth + 18, 336, 1440)).toEqual({
      collapsed: false,
      width: DESKTOP_SHELL.navigationWidth,
    });
  });

  it('keeps a custom width and clamps it to the supported range', () => {
    expect(resolveShellSidebarResize(356, 272, 1440)).toEqual({
      collapsed: false,
      width: 356,
    });

    expect(resolveShellSidebarResize(900, 272, 1000)).toEqual({
      collapsed: false,
      width: 480,
    });
  });

  it('stops live resizing at the minimum width until the close threshold takes over', () => {
    expect(getShellSidebarDragLayout(120, 336, 1440)).toEqual({
      trackWidth: DESKTOP_SHELL.navigationMinWidth,
      surfaceWidth: DESKTOP_SHELL.navigationMinWidth,
      translateX: 0,
    });

    expect(getShellSidebarDragLayout(360, 336, 1440)).toEqual({
      trackWidth: 360,
      surfaceWidth: 360,
      translateX: 0,
    });
  });

  it('caps the free width at a roomy narrow-screen panel size', () => {
    expect(getShellSidebarDragLayout(600, 272, 1440).trackWidth).toBe(480);
    expect(getShellSidebarDragLayout(600, 272, 800).trackWidth).toBe(480);
  });
});
