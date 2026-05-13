import { create } from 'zustand';
import type { CurrentView } from '@/types/navigation';
import { sessionManager } from '../core/session/sessionManager';
import type { SessionManagerEvent } from '../core/session/types';

interface SessionSidebarViewContext {
  currentView: CurrentView | null;
  activeSessionId: string | null;
  isDocumentVisible: boolean;
}

interface SessionSidebarIndicatorsState {
  streamingSessionIds: string[];
  unreadSessionIds: string[];
  viewContext: SessionSidebarViewContext;
  setViewContext: (nextContext: Partial<SessionSidebarViewContext>) => void;
  markSessionSeen: (sessionId: string) => void;
}

const DEFAULT_VIEW_CONTEXT: SessionSidebarViewContext = {
  currentView: null,
  activeSessionId: null,
  isDocumentVisible: true,
};

function getInitialStreamingSessionIds(): string[] {
  return typeof sessionManager.getActiveStreamingSessions === 'function'
    ? sessionManager.getActiveStreamingSessions()
    : [];
}

function subscribeToSessionManagerEvents(
  listener: (event: SessionManagerEvent) => void
): () => void {
  return typeof sessionManager.subscribe === 'function'
    ? sessionManager.subscribe(listener)
    : () => undefined;
}

function addSessionId(sessionIds: string[], sessionId: string): string[] {
  return sessionIds.includes(sessionId) ? sessionIds : [...sessionIds, sessionId];
}

function removeSessionId(sessionIds: string[], sessionId: string): string[] {
  return sessionIds.includes(sessionId)
    ? sessionIds.filter((currentId) => currentId !== sessionId)
    : sessionIds;
}

function isSessionCurrentlyViewed(
  sessionId: string,
  viewContext: SessionSidebarViewContext
): boolean {
  return viewContext.currentView === 'chat-v2'
    && viewContext.activeSessionId === sessionId
    && viewContext.isDocumentVisible;
}

function clearSeenSessionIfNeeded(
  unreadSessionIds: string[],
  viewContext: SessionSidebarViewContext
): string[] {
  if (!viewContext.activeSessionId || !isSessionCurrentlyViewed(viewContext.activeSessionId, viewContext)) {
    return unreadSessionIds;
  }

  return removeSessionId(unreadSessionIds, viewContext.activeSessionId);
}

export const useSessionSidebarIndicators = create<SessionSidebarIndicatorsState>((set) => ({
  streamingSessionIds: getInitialStreamingSessionIds(),
  unreadSessionIds: [],
  viewContext: DEFAULT_VIEW_CONTEXT,
  setViewContext: (nextContext) => {
    set((state) => {
      const viewContext = {
        ...state.viewContext,
        ...nextContext,
      };
      const unreadSessionIds = clearSeenSessionIfNeeded(state.unreadSessionIds, viewContext);

      if (
        viewContext.currentView === state.viewContext.currentView
        && viewContext.activeSessionId === state.viewContext.activeSessionId
        && viewContext.isDocumentVisible === state.viewContext.isDocumentVisible
        && unreadSessionIds === state.unreadSessionIds
      ) {
        return state;
      }

      return {
        viewContext,
        unreadSessionIds,
      };
    });
  },
  markSessionSeen: (sessionId) => {
    set((state) => {
      const unreadSessionIds = removeSessionId(state.unreadSessionIds, sessionId);
      return unreadSessionIds === state.unreadSessionIds ? state : { unreadSessionIds };
    });
  },
}));

function applySessionManagerEvent(event: SessionManagerEvent): void {
  useSessionSidebarIndicators.setState((state) => {
    switch (event.type) {
      case 'streaming-change': {
        const streamingSessionIds = event.isStreaming
          ? addSessionId(state.streamingSessionIds, event.sessionId)
          : removeSessionId(state.streamingSessionIds, event.sessionId);

        const unreadSessionIds = event.isStreaming
          ? removeSessionId(state.unreadSessionIds, event.sessionId)
          : isSessionCurrentlyViewed(event.sessionId, state.viewContext)
            ? removeSessionId(state.unreadSessionIds, event.sessionId)
            : addSessionId(state.unreadSessionIds, event.sessionId);

        if (
          streamingSessionIds === state.streamingSessionIds
          && unreadSessionIds === state.unreadSessionIds
        ) {
          return state;
        }

        return {
          streamingSessionIds,
          unreadSessionIds,
        };
      }
      case 'session-destroyed':
      case 'session-evicted': {
        const streamingSessionIds = removeSessionId(state.streamingSessionIds, event.sessionId);
        const unreadSessionIds = removeSessionId(state.unreadSessionIds, event.sessionId);

        if (
          streamingSessionIds === state.streamingSessionIds
          && unreadSessionIds === state.unreadSessionIds
        ) {
          return state;
        }

        return {
          streamingSessionIds,
          unreadSessionIds,
        };
      }
      default:
        return state;
    }
  });
}

subscribeToSessionManagerEvents(applySessionManagerEvent);

export function setSessionSidebarViewContext(
  nextContext: Partial<SessionSidebarViewContext>
): void {
  useSessionSidebarIndicators.getState().setViewContext(nextContext);
}

export function markSessionSidebarIndicatorSeen(sessionId: string): void {
  useSessionSidebarIndicators.getState().markSessionSeen(sessionId);
}

export function __resetSessionSidebarIndicatorsForTests(): void {
  useSessionSidebarIndicators.setState({
    streamingSessionIds: [],
    unreadSessionIds: [],
    viewContext: DEFAULT_VIEW_CONTEXT,
  });
}

export function __applySessionSidebarEventForTests(event: SessionManagerEvent): void {
  applySessionManagerEvent(event);
}
