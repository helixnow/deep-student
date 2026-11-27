import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSession = vi.hoisted(() => ({
  sessionId: 'bs_1' as string | null,
  currentUrl: 'https://example.com',
  title: 'Example',
  canGoBack: true,
  canGoForward: false,
  controlMode: 'user' as 'user' | 'agent',
  loading: false,
  lastError: null as string | null,
  addressDraft: 'https://example.com',
  contentVisible: true,
  tabs: [{ tabId: 't1', url: 'https://example.com', title: 'Example', active: true }],
  activeTabId: 't1' as string | null,
  screencastFrame: null as {
    data: string;
    mimeType: 'image/jpeg' | 'image/png';
    width: number;
    height: number;
    timestamp: number;
  } | null,
  navigate: vi.fn(async () => undefined),
  back: vi.fn(async () => undefined),
  forward: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined),
  stopLoading: vi.fn(),
  takeOver: vi.fn(async () => undefined),
  showContent: vi.fn(async () => true),
  setAddressDraft: vi.fn(),
  closeSession: vi.fn(async () => undefined),
  refreshTabs: vi.fn(async () => undefined),
  createTab: vi.fn(async () => undefined),
  switchTab: vi.fn(async () => undefined),
  closeTab: vi.fn(async () => undefined),
  sendRemoteInput: vi.fn(async () => undefined),
  promoteToInteractive: vi.fn(async () => 'embedded' as const),
  hydrateFromRust: vi.fn(async () => undefined),
}));

const mockBrowserApi = vi.hoisted(() => ({
  getSurfaceHostMode: vi.fn(async () => 'embedded'),
  setSurfaceBounds: vi.fn(async () => 'embedded'),
  setSurfaceVisibility: vi.fn(async () => 'embedded'),
  promoteToInteractive: vi.fn(async () => 'embedded'),
  releaseSurfaceFocus: vi.fn(async () => undefined),
  extractContent: vi.fn(async () => ({
    url: 'https://example.com',
    title: 'Example',
    markdown: '# Extracted\n\nHello',
    totalChars: 18,
    truncated: false,
  })),
}));

const showGlobalNotificationMock = vi.hoisted(() => vi.fn());
const copyTextToClipboardMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts?.error ? `${key}:${String(opts.error)}` : key,
    }),
  };
});

vi.mock('@/features/browser/hooks/useBrowserSession', () => ({
  useBrowserSession: () => mockSession,
}));

vi.mock('@/features/browser/browserApi', () => ({
  browserApi: mockBrowserApi,
  localizeBrowserGateMessage: (msg: string) => msg,
}));

vi.mock('@/features/browser/gates', () => ({
  resolveBrowserLaunchability: vi.fn(async () => ({ open: true, closeMessage: null })),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: copyTextToClipboardMock,
}));

vi.mock('../../core/shortcuts', () => ({
  useWorkbenchOverlay: () => false,
}));

vi.mock('../../core/windowStore', () => ({
  useWindowStore: { getState: () => ({ windows: { w1: { minimized: false } }, focusStack: ['w1'], focusWindow: vi.fn() }) },
  useWindowTransientPhase: () => null,
}));

vi.mock('../../components/appsPanelStore', () => ({
  useAppsPanelOpen: () => false,
}));

vi.mock('../system/useWbSysSize', () => ({
  useWbSysSize: () => ({ ref: { current: null } }),
}));

import BrowserAppWindow from '../BrowserAppWindow';

const baseProps = {
  windowId: 'w1',
  instanceKey: null,
  launchPayload: undefined,
  onTitleChange: vi.fn(),
  isActive: true,
  isVisible: true,
};

describe('BrowserAppWindow chrome & host modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.sessionId = 'bs_1';
    mockSession.currentUrl = 'https://example.com';
    mockSession.title = 'Example';
    mockSession.canGoBack = true;
    mockSession.canGoForward = false;
    mockSession.controlMode = 'user';
    mockSession.loading = false;
    mockSession.lastError = null;
    mockSession.addressDraft = 'https://example.com';
    mockSession.contentVisible = true;
    mockSession.tabs = [
      { tabId: 't1', url: 'https://example.com', title: 'Example', active: true },
    ];
    mockSession.activeTabId = 't1';
    mockSession.screencastFrame = null;
    mockBrowserApi.getSurfaceHostMode.mockResolvedValue('embedded');
    copyTextToClipboardMock.mockResolvedValue(true);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('renders single-row toolbar with reload, extract, new-tab and preserves data-control-mode', async () => {
    const { container } = render(<BrowserAppWindow {...baseProps} />);

    // No separate stacked AgentBar banner row
    expect(container.querySelector('.wb-browser-agent')).toBeNull();
    expect(container.querySelector('[data-control-mode="user"]')).toBeTruthy();

    // Reload button is shown when idle with an active session
    const reloadBtn = screen.getByRole('button', { name: 'browser.reload' });
    fireEvent.click(reloadBtn);
    expect(mockSession.reload).toHaveBeenCalledTimes(1);

    // New tab button on toolbar right when <= 1 tab
    const newTabBtn = screen.getByRole('button', { name: 'browser.newTab' });
    fireEvent.click(newTabBtn);
    expect(mockSession.createTab).toHaveBeenCalledTimes(1);

    // Extract page text button calls browserApi.extractContent, copies markdown via clipboardUtils, notifies
    const extractBtn = screen.getByRole('button', { name: 'browser.extractContent' });
    fireEvent.click(extractBtn);
    await waitFor(() => {
      expect(mockBrowserApi.extractContent).toHaveBeenCalledWith('bs_1');
      expect(copyTextToClipboardMock).toHaveBeenCalledWith('# Extracted\n\nHello');
      expect(showGlobalNotificationMock).toHaveBeenCalledWith('success', 'browser.extractSuccess');
    });

    // When clipboard copy fails, report error notification (never false success)
    showGlobalNotificationMock.mockClear();
    copyTextToClipboardMock.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    fireEvent.click(extractBtn);
    await waitFor(() => {
      expect(showGlobalNotificationMock).toHaveBeenCalledWith(
        'error',
        'browser.extractFailed:Clipboard unavailable',
      );
    });
  });

  it('shows inline agent control pill and takeOver button in agent mode', () => {
    mockSession.controlMode = 'agent';
    const { container } = render(<BrowserAppWindow {...baseProps} />);

    const control = container.querySelector('.wb-browser-toolbar [data-control-mode="agent"]');
    expect(control).toBeTruthy();
    const takeOverBtn = screen.getByRole('button', { name: 'browser.takeOver' });
    fireEvent.click(takeOverBtn);
    expect(mockSession.takeOver).toHaveBeenCalledTimes(1);
  });

  it('renders dedicated headless and unsupported hostMode views', async () => {
    mockBrowserApi.getSurfaceHostMode
      .mockResolvedValueOnce('headless')
      .mockResolvedValueOnce('embedded');
    const { container, unmount } = render(<BrowserAppWindow {...baseProps} />);

    await waitFor(() => {
      expect(container.querySelector('[data-wb-browser-headless]')).toBeTruthy();
    });
    const promoteBtn = screen.getByRole('button', { name: 'browser.promoteForeground' });
    fireEvent.click(promoteBtn);
    await waitFor(() => {
      expect(mockSession.promoteToInteractive).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-wb-browser-headless]')).toBeNull();
    });
    unmount();

    mockBrowserApi.getSurfaceHostMode.mockResolvedValueOnce('unsupported');
    const { container: unsupportedContainer } = render(<BrowserAppWindow {...baseProps} />);
    await waitFor(() => {
      expect(unsupportedContainer.querySelector('[data-wb-browser-unsupported]')).toBeTruthy();
    });
  });

  it('forwards throttled pointerMove and CJK IME compositionEnd in RemoteScreencastViewport', async () => {
    mockBrowserApi.getSurfaceHostMode.mockResolvedValueOnce('remote');
    mockSession.screencastFrame = {
      data: 'AA==',
      mimeType: 'image/png',
      width: 1000,
      height: 500,
      timestamp: 1,
    };

    const { container } = render(<BrowserAppWindow {...baseProps} />);
    await waitFor(() => {
      expect(container.querySelector('[data-wb-browser-remote-viewport]')).toBeTruthy();
    });

    const viewport = container.querySelector('[data-wb-browser-remote-viewport]') as HTMLElement;
    const img = container.querySelector('.wb-browser-remote-image') as HTMLImageElement;
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 500,
      height: 250,
      right: 500,
      bottom: 250,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);
    fireEvent(viewport, new MouseEvent('pointermove', { bubbles: true, clientX: 250, clientY: 125 }));
    expect(mockSession.sendRemoteInput).toHaveBeenCalledWith({
      type: 'mouseMoved',
      x: 500,
      y: 250,
      modifiers: [],
    });

    // Within 60ms throttle window -> skipped
    nowSpy.mockReturnValue(1030);
    fireEvent(viewport, new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 150 }));
    expect(mockSession.sendRemoteInput).toHaveBeenCalledTimes(1);

    // After 60ms -> forwarded
    nowSpy.mockReturnValue(1070);
    fireEvent(viewport, new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 150 }));
    expect(mockSession.sendRemoteInput).toHaveBeenCalledTimes(2);

    // Chinese IME composition: keyDown ignored during composition, compositionEnd emits insertText
    const imeInput = container.querySelector('.wb-browser-ime-input') as HTMLInputElement;
    act(() => {
      fireEvent.compositionStart(imeInput);
      fireEvent.keyDown(imeInput, { key: 'n' });
      fireEvent.compositionEnd(imeInput, { data: '你好' });
    });

    expect(mockSession.sendRemoteInput).toHaveBeenLastCalledWith({
      type: 'insertText',
      text: '你好',
    });
    nowSpy.mockRestore();
  });

  it('maps object-fit:contain letterbox coords, prevents default on pointerDown/wheel, and keeps IME focused', async () => {
    mockBrowserApi.getSurfaceHostMode.mockResolvedValueOnce('remote');
    mockSession.screencastFrame = {
      data: 'AA==',
      mimeType: 'image/png',
      width: 1000,
      height: 500,
      timestamp: 2,
    };

    const { container } = render(<BrowserAppWindow {...baseProps} />);
    await waitFor(() => {
      expect(container.querySelector('[data-wb-browser-remote-viewport]')).toBeTruthy();
    });

    const viewport = container.querySelector('[data-wb-browser-remote-viewport]') as HTMLElement;
    const img = container.querySelector('.wb-browser-remote-image') as HTMLImageElement;
    const imeInput = container.querySelector('.wb-browser-ime-input') as HTMLInputElement;

    // 500x500 container holding a 1000x500 (2:1) frame:
    // rendered box is 500x250 centered vertically -> y in [125, 375], x in [0, 500].
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 500,
      height: 500,
      right: 500,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // Click inside top letterbox (y=50 < 125): must preventDefault, focus IME, and emit NO remote click
    const letterboxDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: 250,
      clientY: 50,
      button: 0,
    });
    act(() => {
      viewport.dispatchEvent(letterboxDown);
    });
    expect(letterboxDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(imeInput);
    expect(mockSession.sendRemoteInput).not.toHaveBeenCalled();

    // Click at rendered frame center (250, 250) -> maps to (500, 250)
    const centerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: 250,
      clientY: 250,
      button: 0,
    });
    act(() => {
      viewport.dispatchEvent(centerDown);
    });
    expect(centerDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(imeInput);
    expect(mockSession.sendRemoteInput).toHaveBeenCalledWith({
      type: 'mousePressed',
      x: 500,
      y: 250,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    });

    // Non-passive native wheel listener calls preventDefault and maps coords inside rendered box
    const wheelEvent = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 125,
      clientY: 187.5,
      deltaX: 0,
      deltaY: 120,
    });
    act(() => {
      viewport.dispatchEvent(wheelEvent);
    });
    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(mockSession.sendRemoteInput).toHaveBeenLastCalledWith({
      type: 'mouseWheel',
      x: 250,
      y: 125,
      deltaX: 0,
      deltaY: 120,
      modifiers: [],
    });
  });
});
