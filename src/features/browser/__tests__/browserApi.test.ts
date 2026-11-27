import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const assertGatesMock = vi.hoisted(() => vi.fn(async () => ({ open: true })));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));
vi.mock('../gates', async () => {
  const actual = await vi.importActual<typeof import('../gates')>('../gates');
  return {
    ...actual,
    assertBrowserGatesOpen: assertGatesMock,
    assertBrowserLaunchable: assertGatesMock,
  };
});

import {
  BrowserApiError,
  closeTab,
  extractContent,
  getHostFacts,
  listTabs,
  newTab,
  openSession,
  parseBrowserExtractedContent,
  parseBrowserHostFacts,
  parseBrowserSurfaceHostMode,
  parseBrowserSessionSnapshot,
  promoteToInteractive,
  releaseSurfaceFocus,
  remoteInput,
  setSurfaceBounds,
  setSurfaceVisibility,
  switchTab,
  toBrowserApiError,
} from '../browserApi';

describe('browserApi contracts', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    assertGatesMock.mockReset();
    assertGatesMock.mockResolvedValue({
      workbenchModeEnabled: true,
      browserEnabled: true,
      open: true,
    });
  });

  it('forwards Agent origin when opening a new session', async () => {
    invokeMock.mockResolvedValueOnce(null);

    await openSession('example.com/path', { fromAgent: true });

    expect(assertGatesMock).toHaveBeenCalled();
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
    expect(parseBrowserSurfaceHostMode('remote')).toBe('remote');
    expect(parseBrowserSurfaceHostMode('headless')).toBe('headless');
    expect(parseBrowserSurfaceHostMode('unsupported')).toBe('unsupported');
    expect(parseBrowserSurfaceHostMode('unknown')).toBe('detached');
    expect(parseBrowserSurfaceHostMode(null)).toBe('detached');
  });

  it('forwards tab management and remote input commands to IPC', async () => {
    invokeMock
      .mockResolvedValueOnce([
        { tabId: 't1', url: 'https://a.example', title: 'A', active: true },
        { tabId: 't2', url: 'https://b.example', title: 'B', active: false },
      ])
      .mockResolvedValueOnce({ tabId: 't3', url: 'https://c.example', title: 'C', active: true })
      .mockResolvedValueOnce({ tabId: 't2', url: 'https://b.example', title: 'B', active: true })
      .mockResolvedValueOnce({ closed: true })
      .mockResolvedValueOnce(null);

    const tabs = await listTabs('bs_1');
    expect(tabs).toHaveLength(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'browser_list_tabs', { sessionId: 'bs_1' });

    const created = await newTab('bs_1', 'c.example');
    expect(created.tabId).toBe('t3');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'browser_new_tab', {
      sessionId: 'bs_1',
      url: 'https://c.example',
    });

    const switched = await switchTab('bs_1', 't2');
    expect(switched.tabId).toBe('t2');
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'browser_switch_tab', {
      sessionId: 'bs_1',
      tabId: 't2',
    });

    await closeTab('bs_1', 't3');
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'browser_close_tab', {
      sessionId: 'bs_1',
      tabId: 't3',
    });

    await remoteInput('bs_1', { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'browser_remote_input', {
      sessionId: 'bs_1',
      event: { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 },
    });
  });

  it('forwards extractContent and getHostFacts to IPC and normalizes payloads', async () => {
    invokeMock
      .mockResolvedValueOnce({
        url: 'https://example.com/article',
        title: 'Example Article',
        markdown: '# Heading\n\nBody text',
        total_chars: 20,
        truncated: false,
      })
      .mockResolvedValueOnce({
        session_id: 'bs_1',
        mode: 'remote',
        visited_origins: ['https://example.com'],
        blocked_navigations: [
          { url: 'http://127.0.0.1/', reason: 'private_network', at: '2026-11-27T00:00:00Z' },
        ],
        latest_screenshot: {
          path: 'artifacts/shot.png',
          locator: 'artifacts://shot.png',
          width: 1280,
          height: 720,
          captured_at: '2026-11-27T00:01:00Z',
        },
        downloads_count: 1,
        user_takeover_count: 2,
        action_count: 5,
        final_url: 'https://example.com/article',
      });

    const extracted = await extractContent('bs_1', { maxChars: 4000, startIndex: 0 });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'browser_extract_content', {
      sessionId: 'bs_1',
      maxChars: 4000,
      startIndex: 0,
    });
    expect(extracted).toEqual({
      url: 'https://example.com/article',
      title: 'Example Article',
      markdown: '# Heading\n\nBody text',
      totalChars: 20,
      truncated: false,
    });

    const facts = await getHostFacts('bs_1');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'browser_get_host_facts', {
      sessionId: 'bs_1',
    });
    expect(facts).toEqual({
      sessionId: 'bs_1',
      mode: 'remote',
      visitedOrigins: ['https://example.com'],
      blockedNavigations: [
        { url: 'http://127.0.0.1/', reason: 'private_network', at: '2026-11-27T00:00:00Z' },
      ],
      latestScreenshot: {
        path: 'artifacts/shot.png',
        locator: 'artifacts://shot.png',
        width: 1280,
        height: 720,
        capturedAt: '2026-11-27T00:01:00Z',
      },
      downloadsCount: 1,
      userTakeoverCount: 2,
      actionCount: 5,
      finalUrl: 'https://example.com/article',
    });

    expect(parseBrowserExtractedContent('plain text')).toEqual({
      url: '',
      title: '',
      markdown: 'plain text',
      totalChars: 10,
      truncated: false,
    });
    expect(parseBrowserHostFacts(null)).toMatchObject({
      sessionId: '',
      mode: 'interactive',
      visitedOrigins: [],
      blockedNavigations: [],
      latestScreenshot: null,
    });
  });

  it('promotes headless session via browser_promote_to_interactive with fallback when command missing', async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('embedded');

    const promotedMode = await promoteToInteractive('bs_1');
    expect(promotedMode).toBe('embedded');
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'browser_promote_to_interactive', {
      sessionId: 'bs_1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'browser_get_surface_host_mode');

    invokeMock.mockReset();
    invokeMock
      .mockRejectedValueOnce(new Error('Command browser_promote_to_interactive not found'))
      .mockResolvedValueOnce('detached');

    const fallbackMode = await promoteToInteractive('bs_1');
    expect(fallbackMode).toBe('detached');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'browser_set_surface_visibility', {
      sessionId: 'bs_1',
      visible: true,
      focus: true,
    });
  });
});
