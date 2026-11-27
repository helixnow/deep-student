import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  switchTab: vi.fn(),
  closeTab: vi.fn(),
  listTabs: vi.fn(),
  promoteToInteractive: vi.fn(),
}));

vi.mock('../browserApi', async () => {
  const actual = await vi.importActual<typeof import('../browserApi')>('../browserApi');
  return {
    ...actual,
    switchTab: apiMocks.switchTab,
    closeTab: apiMocks.closeTab,
    listTabs: apiMocks.listTabs,
    promoteToInteractive: apiMocks.promoteToInteractive,
  };
});

import { INITIAL_BROWSER_SESSION_STATE, useBrowserSessionStore } from '../sessionStore';

describe('useBrowserSessionStore tab sync & headless promotion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      sessionId: 'bs_1',
      currentUrl: 'https://docs.example.com',
      title: 'Docs',
      addressDraft: 'https://docs.example.com',
      tabs: [
        { tabId: 't1', url: 'https://docs.example.com', title: 'Docs', active: true },
        { tabId: 't2', url: 'about:blank', title: '', active: false },
      ],
      activeTabId: 't1',
    });
  });

  it('switchTab unconditionally clears stale title and blanks addressDraft for about:blank', async () => {
    apiMocks.switchTab.mockResolvedValueOnce({
      tabId: 't2',
      url: 'about:blank',
      title: '',
      active: true,
    });
    apiMocks.listTabs.mockResolvedValueOnce([
      { tabId: 't1', url: 'https://docs.example.com', title: 'Docs', active: false },
      { tabId: 't2', url: 'about:blank', title: '', active: true },
    ]);

    await useBrowserSessionStore.getState().switchTab('t2');

    const state = useBrowserSessionStore.getState();
    expect(state.activeTabId).toBe('t2');
    expect(state.currentUrl).toBe('about:blank');
    expect(state.title).toBe('');
    expect(state.addressDraft).toBe('');
  });

  it('closeTab resets session state when remainingCount === 0', async () => {
    apiMocks.closeTab.mockResolvedValueOnce({ closed: true, remainingCount: 0 });

    await useBrowserSessionStore.getState().closeTab('t1');

    const state = useBrowserSessionStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.currentUrl).toBe('');
    expect(state.title).toBe('');
    expect(state.addressDraft).toBe('');
    expect(apiMocks.listTabs).not.toHaveBeenCalled();
  });

  it('closeTab resets session state when closed is true and refreshed tabs list is empty', async () => {
    apiMocks.closeTab.mockResolvedValueOnce({ closed: true });
    apiMocks.listTabs.mockResolvedValueOnce([]);

    await useBrowserSessionStore.getState().closeTab('t1');

    const state = useBrowserSessionStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.currentUrl).toBe('');
    expect(state.title).toBe('');
    expect(state.addressDraft).toBe('');
  });

  it('promoteToInteractive invokes browserApi.promoteToInteractive and marks contentVisible', async () => {
    apiMocks.promoteToInteractive.mockResolvedValueOnce('embedded');

    const mode = await useBrowserSessionStore.getState().promoteToInteractive();

    expect(mode).toBe('embedded');
    expect(apiMocks.promoteToInteractive).toHaveBeenCalledWith('bs_1');
    expect(useBrowserSessionStore.getState().contentVisible).toBe(true);
  });
});
