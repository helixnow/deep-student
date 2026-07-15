import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  BrowserApiError,
  openSession,
  parseBrowserSurfaceHostMode,
  parseBrowserSessionSnapshot,
  releaseSurfaceFocus,
  setSurfaceBounds,
  setSurfaceVisibility,
  toBrowserApiError,
} from '../browserApi';

describe('browserApi contracts', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('forwards Agent origin when opening a new session', async () => {
    invokeMock.mockResolvedValueOnce(null);

    await openSession('example.com/path', { fromAgent: true });

    expect(invokeMock).toHaveBeenCalledWith('browser_open_session', {
      url: 'https://example.com/path',
      fromAgent: true,
    });
  });

  it('parses flattened Rust history and platform capability fields', () => {
    const snapshot = parseBrowserSessionSnapshot({
      id: 'bs_1',
      url: 'https://example.com/final',
      title: 'Final',
      canGoBack: true,
      canGoForward: false,
      controlMode: 'Agent',
      loading: false,
      historyIndex: 1,
      history: [
        {
          url: 'https://example.com/start',
          title: 'Start',
          visitedAt: '2026-07-11T00:00:00Z',
        },
        {
          url: 'https://example.com/final',
          title: 'Final',
          visited_at: '2026-07-11T00:01:00Z',
        },
      ],
      agentAutomationSupported: true,
    });

    expect(snapshot).toMatchObject({
      sessionId: 'bs_1',
      currentUrl: 'https://example.com/final',
      controlMode: 'agent',
      historyIndex: 1,
      agentAutomationSupported: true,
    });
    expect(snapshot.history.map((entry) => entry.url)).toEqual([
      'https://example.com/start',
      'https://example.com/final',
    ]);
    expect(snapshot.history[1]?.visitedAt).toBe('2026-07-11T00:01:00Z');
  });

  it('preserves structured backend error prefixes as BrowserApiError codes', () => {
    const error = toBrowserApiError(
      'browser_navigate',
      new Error('NAVIGATION_BLOCKED: private/internal target'),
    );

    expect(error).toBeInstanceOf(BrowserApiError);
    expect(error.code).toBe('NAVIGATION_BLOCKED');
    expect(error.command).toBe('browser_navigate');
  });

  it('forwards logical surface bounds and visibility to Rust', async () => {
    invokeMock.mockResolvedValueOnce('embedded').mockResolvedValueOnce('embedded');

    await setSurfaceBounds(
      'bs_1',
      {
        x: 10,
        y: 20,
        width: 800,
        height: 600,
        viewportWidth: 1440,
        viewportHeight: 900,
        occlusions: [{ x: 20, y: 30, width: 100, height: 40 }],
        inputOcclusions: [{ x: 10, y: 20, width: 800, height: 600 }],
      },
      42,
    );
    await setSurfaceVisibility('bs_1', false);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'browser_set_surface_bounds', {
      sessionId: 'bs_1',
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      viewportWidth: 1440,
      viewportHeight: 900,
      occlusions: [{ x: 20, y: 30, width: 100, height: 40 }],
      inputOcclusions: [{ x: 10, y: 20, width: 800, height: 600 }],
      sequence: 42,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'browser_set_surface_visibility', {
      sessionId: 'bs_1',
      visible: false,
      focus: false,
    });
  });

  it('returns native browser keyboard focus to the React shell', async () => {
    invokeMock.mockResolvedValueOnce(null);

    await releaseSurfaceFocus('bs_1');

    expect(invokeMock).toHaveBeenCalledWith('browser_release_surface_focus', {
      sessionId: 'bs_1',
    });
  });

  it('parses host mode conservatively', () => {
    expect(parseBrowserSurfaceHostMode('embedded')).toBe('embedded');
    expect(parseBrowserSurfaceHostMode({ host_mode: 'embedded' })).toBe('embedded');
    expect(parseBrowserSurfaceHostMode('unsupported')).toBe('unsupported');
    expect(parseBrowserSurfaceHostMode('unknown')).toBe('detached');
    expect(parseBrowserSurfaceHostMode(null)).toBe('detached');
  });
});
