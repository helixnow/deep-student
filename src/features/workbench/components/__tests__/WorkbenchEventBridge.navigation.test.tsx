import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch, activate, isEnabled, getApp, getCurrentSessionId, openChatSessionMock, launchNewChatSessionMock } = vi.hoisted(() => ({
  launch: vi.fn(),
  activate: vi.fn(async () => true),
  isEnabled: vi.fn(() => true),
  getApp: vi.fn((typeId: string) =>
    typeId === 'flashcards' || typeId === 'chat' || typeId === 'files' ? { typeId } : undefined,
  ),
  getCurrentSessionId: vi.fn<() => string | null>(() => null),
  openChatSessionMock: vi.fn(),
  launchNewChatSessionMock: vi.fn(async () => ({ sessionId: 'sess_new', windowId: 'win-chat-new' })),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../core/workbenchBus', () => ({ workbenchBus: { launch, activate, isEnabled } }));
vi.mock('../../core/appRegistry', () => ({ appRegistry: { get: getApp } }));
vi.mock('../../core/windowStore', () => ({
  useWindowStore: { getState: () => ({ windows: {}, focusStack: [], focusWindow: vi.fn() }) },
}));
vi.mock('../../apps/notes/workspaceRegistry', () => ({ requestWorkspaceResource: vi.fn(async () => 'w') }));
vi.mock('../../apps/content/typeMap', () => ({
  isNotesWorkspaceResourceType: (type: string) => type === 'note' || type === 'mindmap',
  resourceTypeToAppTypeId: (type: string) => type,
}));
vi.mock('../../apps/chat/newSession', () => ({
  launchNewChatSession: launchNewChatSessionMock,
  openChatSession: openChatSessionMock,
}));
vi.mock('../../apps/chat/register', () => ({ CHAT_APP_TYPE_ID: 'chat' }));
vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: { getCurrentSessionId },
}));
vi.mock('../../hooks/useWorkbenchA11y', () => ({ announceWorkbench: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { notifyWorkbenchHostChanged } from '@/shared/workbenchHost';
import WorkbenchEventBridge from '../WorkbenchEventBridge';

afterEach(() => {
  cleanup();
  launch.mockReset();
  activate.mockClear();
  isEnabled.mockReset().mockReturnValue(true);
  getApp.mockReset().mockImplementation((typeId: string) =>
    typeId === 'flashcards' || typeId === 'chat' || typeId === 'files' ? { typeId } : undefined,
  );
  getCurrentSessionId.mockReset().mockReturnValue(null);
  openChatSessionMock.mockReset();
  launchNewChatSessionMock.mockReset().mockResolvedValue({ sessionId: 'sess_new', windowId: 'win-chat-new' });
  window.history.replaceState(null, '', '/');
});

const fire = (type: string, detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent(type, { detail })); });

describe('WorkbenchEventBridge classic navigation events (previously dead in workbench)', () => {
  it('opens the question set window for navigateToExamSheet', () => {
    render(<WorkbenchEventBridge />);
    fire('navigateToExamSheet', { sessionId: 'exam_1' });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'exam', instanceKey: 'exam_1' }));
  });

  it('opens the settings window for SETTINGS_NAVIGATE_TAB and NAVIGATE_TO_VIEW{view:"settings"}', () => {
    render(<WorkbenchEventBridge />);
    fire('SETTINGS_NAVIGATE_TAB', { tab: 'apis' });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'settings' }));
    launch.mockReset();
    fire('NAVIGATE_TO_VIEW', { view: 'settings' });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'settings' }));
  });

  it('opens the resource window for NAVIGATE_TO_VIEW{openResource} and ignores plain view switches', () => {
    render(<WorkbenchEventBridge />);
    fire('NAVIGATE_TO_VIEW', { view: 'learning-hub' });
    expect(launch).not.toHaveBeenCalled();
    fire('NAVIGATE_TO_VIEW', { view: 'learning-hub', openResource: '/tb_42' });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ instanceKey: 'tb_42' }));
  });

  it('routes knowledge-base locate to the document and memory locate to the Files memory view', () => {
    render(<WorkbenchEventBridge />);
    fire('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', { preferTab: 'manage', locator: { sourceId: 'file_9', resourceType: 'file', title: 'Doc' } });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'file', instanceKey: 'file_9' }));
    fire('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', { preferTab: 'memory', locator: { sourceId: 'note_m' } });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      typeId: 'files', action: 'openQuickAccess', payload: { type: 'memory' },
      fallbackLaunch: expect.objectContaining({ typeId: 'files' }),
    }));
  });

  it('opens the chat window with fallbackLaunch when CHAT_V2_SET_INPUT arrives with a closed chat window', () => {
    getCurrentSessionId.mockReturnValue('sess_existing');
    render(<WorkbenchEventBridge />);
    fire('CHAT_V2_SET_INPUT', { content: '请帮我深入讲解这处作文批注' });
    expect(openChatSessionMock).toHaveBeenCalledWith('sess_existing', 'api');
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      typeId: 'chat',
      instanceKey: 'sess_existing',
      action: 'setInput',
      payload: { content: '请帮我深入讲解这处作文批注', focus: true, sessionId: 'sess_existing' },
      fallbackLaunch: expect.objectContaining({ typeId: 'chat', instanceKey: 'sess_existing' }),
    }));
  });
});

describe('WorkbenchEventBridge pdf-ref:open (sole handler for known resource ids on the desktop)', () => {
  it('opens one reader window and re-sends the page jump until the reader acknowledges it', () => {
    vi.useFakeTimers();
    try {
      const focuses: Array<{ sourceId?: string; pageNumber?: number; quote?: string; acknowledge?: (ok: boolean) => void }> = [];
      const documentDispatch = document.dispatchEvent.bind(document);
      const dispatchSpy = vi.spyOn(document, 'dispatchEvent').mockImplementation((event) => {
        if (event.type === 'pdf-ref:focus') focuses.push((event as CustomEvent).detail);
        return documentDispatch(event);
      });
      render(<WorkbenchEventBridge />);

      act(() => {
        document.dispatchEvent(new CustomEvent('pdf-ref:open', { detail: { sourceId: 'tb_42', pageNumber: 12, quote: '特征值' } }));
      });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'textbook', instanceKey: 'tb_42' }));

      // 资源窗冷开：前几次派发没有阅读器接（旧的 0/250/800ms 三连发到这里就全部落空了）
      act(() => { vi.advanceTimersByTime(1000); });
      expect(focuses).toHaveLength(3);
      // 阅读器挂上后的下一次重发被接住并确认
      act(() => { vi.advanceTimersByTime(700); });
      expect(focuses).toHaveLength(4);
      expect(focuses[3]).toEqual(expect.objectContaining({ sourceId: 'tb_42', pageNumber: 12, quote: '特征值', path: '/tb_42' }));
      focuses[3]!.acknowledge?.(true);
      // 确认之后不再重发
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(focuses).toHaveLength(4);
      dispatchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits until workbenchBus is enabled before consuming ?shortcut=review', () => {
    window.history.replaceState(null, '', '/?shortcut=review');
    isEnabled.mockReturnValue(false);
    launch.mockReturnValue('win-flashcards-1');

    render(<WorkbenchEventBridge />);
    expect(launch).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('shortcut')).toBe('review');

    isEnabled.mockReturnValue(true);
    act(() => {
      notifyWorkbenchHostChanged();
    });

    expect(launch).toHaveBeenCalledWith({ typeId: 'flashcards', reason: 'api' });
    expect(new URLSearchParams(window.location.search).has('shortcut')).toBe(false);
  });

  it('leaves legacy refs (no sourceId, or an id without a resource prefix) to the chat page', () => {
    render(<WorkbenchEventBridge />);
    act(() => {
      document.dispatchEvent(new CustomEvent('pdf-ref:open', { detail: { pageNumber: 3 } }));
      document.dispatchEvent(new CustomEvent('pdf-ref:open', { detail: { sourceId: 'sha256:abcdef', pageNumber: 7 } }));
    });
    // 对话页从会话附件里解析这类引用；桌面这边不另开一扇（打不开的）'file' 窗
    expect(launch).not.toHaveBeenCalled();
  });
});
