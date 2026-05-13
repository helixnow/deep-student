import { beforeEach, describe, expect, it } from 'vitest';
import {
  __applySessionSidebarEventForTests,
  __resetSessionSidebarIndicatorsForTests,
  setSessionSidebarViewContext,
  useSessionSidebarIndicators,
} from '../useSessionSidebarIndicators';

describe('useSessionSidebarIndicators', () => {
  beforeEach(() => {
    __resetSessionSidebarIndicatorsForTests();
  });

  it('marks a completed background session as unread until the user views it', () => {
    setSessionSidebarViewContext({
      currentView: 'learning-hub',
      activeSessionId: 'session-a',
      isDocumentVisible: true,
    });

    __applySessionSidebarEventForTests({
      type: 'streaming-change',
      sessionId: 'session-a',
      isStreaming: true,
    });
    __applySessionSidebarEventForTests({
      type: 'streaming-change',
      sessionId: 'session-a',
      isStreaming: false,
    });

    expect(useSessionSidebarIndicators.getState().streamingSessionIds).toEqual([]);
    expect(useSessionSidebarIndicators.getState().unreadSessionIds).toEqual(['session-a']);

    setSessionSidebarViewContext({
      currentView: 'chat-v2',
      activeSessionId: 'session-a',
      isDocumentVisible: true,
    });

    expect(useSessionSidebarIndicators.getState().unreadSessionIds).toEqual([]);
  });

  it('does not mark the visible active chat session as unread after completion', () => {
    setSessionSidebarViewContext({
      currentView: 'chat-v2',
      activeSessionId: 'session-b',
      isDocumentVisible: true,
    });

    __applySessionSidebarEventForTests({
      type: 'streaming-change',
      sessionId: 'session-b',
      isStreaming: false,
    });

    expect(useSessionSidebarIndicators.getState().unreadSessionIds).toEqual([]);
  });

  it('keeps a completed session unread while the document is hidden and clears it on return', () => {
    setSessionSidebarViewContext({
      currentView: 'chat-v2',
      activeSessionId: 'session-c',
      isDocumentVisible: false,
    });

    __applySessionSidebarEventForTests({
      type: 'streaming-change',
      sessionId: 'session-c',
      isStreaming: false,
    });

    expect(useSessionSidebarIndicators.getState().unreadSessionIds).toEqual(['session-c']);

    setSessionSidebarViewContext({
      isDocumentVisible: true,
    });

    expect(useSessionSidebarIndicators.getState().unreadSessionIds).toEqual([]);
  });

  it('drops stale indicators when a session is destroyed', () => {
    __applySessionSidebarEventForTests({
      type: 'streaming-change',
      sessionId: 'session-d',
      isStreaming: true,
    });
    __applySessionSidebarEventForTests({
      type: 'streaming-change',
      sessionId: 'session-d',
      isStreaming: false,
    });

    expect(useSessionSidebarIndicators.getState().unreadSessionIds).toEqual(['session-d']);

    __applySessionSidebarEventForTests({
      type: 'session-destroyed',
      sessionId: 'session-d',
    });

    expect(useSessionSidebarIndicators.getState().streamingSessionIds).toEqual([]);
    expect(useSessionSidebarIndicators.getState().unreadSessionIds).toEqual([]);
  });
});
