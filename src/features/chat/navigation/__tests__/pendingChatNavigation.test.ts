import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invalidatePendingChatNavigation,
  isChatPageReady,
  markChatPageReady,
  peekPendingChatNavigation,
  requestChatNewSession,
  requestChatSessionNavigation,
  resetChatNavigationHandshakeForTest,
} from '../pendingChatNavigation';

describe('pendingChatNavigation', () => {
  beforeEach(() => {
    resetChatNavigationHandshakeForTest();
  });

  afterEach(() => {
    resetChatNavigationHandshakeForTest();
  });

  it('notifies the shell immediately and replays a cold session navigation at ready', () => {
    const received = vi.fn();
    window.addEventListener('navigate-to-session', received);
    try {
      requestChatSessionNavigation('sess_cold');

      expect(received).toHaveBeenCalledOnce();
      expect(peekPendingChatNavigation()).toEqual({
        kind: 'session',
        sessionId: 'sess_cold',
      });

      const release = markChatPageReady();
      expect(received).toHaveBeenCalledTimes(2);
      expect(peekPendingChatNavigation()).toBeNull();
      expect(isChatPageReady()).toBe(true);

      release();
      release();
      expect(isChatPageReady()).toBe(false);
    } finally {
      window.removeEventListener('navigate-to-session', received);
    }
  });

  it('keeps only the latest cold navigation intent', () => {
    const sessionIds: string[] = [];
    const listener = (event: Event) => {
      sessionIds.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    };
    window.addEventListener('navigate-to-session', listener);
    try {
      requestChatSessionNavigation('sess_old');
      requestChatSessionNavigation('sess_latest');
      expect(peekPendingChatNavigation()).toEqual({
        kind: 'session',
        sessionId: 'sess_latest',
      });

      markChatPageReady();
      expect(sessionIds).toEqual(['sess_old', 'sess_latest', 'sess_latest']);
    } finally {
      window.removeEventListener('navigate-to-session', listener);
    }
  });

  it('replays a cold new-session request once after the shell event', () => {
    const received = vi.fn();
    window.addEventListener('CHAT_NEW_SESSION', received);
    try {
      requestChatNewSession();
      expect(received).toHaveBeenCalledOnce();
      expect(peekPendingChatNavigation()).toEqual({ kind: 'new-session' });

      markChatPageReady();
      expect(received).toHaveBeenCalledTimes(2);
      expect(peekPendingChatNavigation()).toBeNull();
    } finally {
      window.removeEventListener('CHAT_NEW_SESSION', received);
    }
  });

  it('dispatches ready navigation once and allows manual selection to cancel pending work', () => {
    const received = vi.fn();
    window.addEventListener('navigate-to-session', received);
    try {
      const release = markChatPageReady();
      requestChatSessionNavigation('sess_ready');
      expect(received).toHaveBeenCalledOnce();
      expect(peekPendingChatNavigation()).toBeNull();
      release();

      requestChatSessionNavigation('sess_cancelled');
      invalidatePendingChatNavigation();
      markChatPageReady();
      expect(received).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('navigate-to-session', received);
    }
  });
});
