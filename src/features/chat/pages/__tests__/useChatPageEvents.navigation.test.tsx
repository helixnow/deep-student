import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import {
  requestChatNewSession,
  requestChatSessionNavigation,
  resetChatNavigationHandshakeForTest,
} from '../../navigation/pendingChatNavigation';
import {
  useChatPageEvents,
  type UseChatPageEventsDeps,
} from '../useChatPageEvents';

function Harness({ deps }: { deps: UseChatPageEventsDeps }) {
  useChatPageEvents(deps);
  return null;
}

function makeDeps(
  overrides: Partial<UseChatPageEventsDeps> = {},
): UseChatPageEventsDeps {
  return {
    notesContext: null,
    t: ((key: string) => key) as unknown as TFunction,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    isInitialLoading: true,
    currentSessionId: 'sess_current',
    createSession: vi.fn().mockResolvedValue(undefined),
    createAnalysisSession: vi.fn().mockResolvedValue(undefined),
    setSessions: vi.fn(),
    setCurrentSessionId: vi.fn(),
    canvasSidebarOpen: false,
    toggleCanvasSidebar: vi.fn(),
    setPendingOpenResource: vi.fn(),
    setOpenApp: vi.fn(),
    isSmallScreen: false,
    setMobileResourcePanelOpen: vi.fn(),
    attachmentPreviewOpen: false,
    setAttachmentPreviewOpen: vi.fn(),
    sidebarCollapsed: false,
    handleSidebarCollapsedChange: vi.fn(),
    setSessionSheetOpen: vi.fn(),
    ...overrides,
  };
}

describe('useChatPageEvents navigation handshake', () => {
  afterEach(() => {
    resetChatNavigationHandshakeForTest();
  });

  it('ignores the shell-opening event during load and consumes its replay after ready', async () => {
    const setCurrentSessionId = vi.fn();
    const base = makeDeps({ setCurrentSessionId });
    const { rerender } = render(<Harness deps={base} />);

    act(() => {
      requestChatSessionNavigation('sess_target');
    });
    expect(setCurrentSessionId).not.toHaveBeenCalled();

    rerender(<Harness deps={{ ...base, isInitialLoading: false }} />);
    await waitFor(() => {
      expect(setCurrentSessionId).toHaveBeenCalledWith('sess_target');
    });
    expect(setCurrentSessionId).toHaveBeenCalledTimes(1);
  });

  it('does not create early and creates exactly once from the ready replay', async () => {
    const createSession = vi.fn().mockResolvedValue(undefined);
    const base = makeDeps({ createSession });
    const { rerender } = render(<Harness deps={base} />);

    act(() => {
      requestChatNewSession();
    });
    expect(createSession).not.toHaveBeenCalled();

    rerender(<Harness deps={{ ...base, isInitialLoading: false }} />);
    await waitFor(() => {
      expect(createSession).toHaveBeenCalledTimes(1);
    });
  });
});
