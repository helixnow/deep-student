/**
 * Chat 导航握手（pendingChatNavigation）行为契约：
 * - 未就绪：navigate-to-session 意图挂起，同时派发一次标准事件供壳层开窗；
 * - 就绪（markChatPageReady）：立即消费挂起意图并重放为标准 CustomEvent；
 * - 就绪态下请求直接派发事件（既有监听者不受影响）；
 * - CHAT_NEW_SESSION 未就绪时事件照发（壳层靠它开窗/切视图），同时入 pending；
 * - invalidate（用户手动切会话 / 页面直接消费）作废挂起意图。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invalidatePendingChatNavigation,
  isChatPageReady,
  markChatPageReady,
  peekPendingChatNavigation,
  requestChatNewSession,
  requestChatSessionNavigation,
  resetChatNavigationHandshakeForTest,
} from '@/features/chat/navigation/pendingChatNavigation';

describe('pendingChatNavigation handshake', () => {
  const navigateListener = vi.fn();
  const newSessionListener = vi.fn();

  beforeEach(() => {
    resetChatNavigationHandshakeForTest();
    navigateListener.mockClear();
    newSessionListener.mockClear();
    window.addEventListener('navigate-to-session', navigateListener);
    window.addEventListener('CHAT_NEW_SESSION', newSessionListener);
  });

  afterEach(() => {
    window.removeEventListener('navigate-to-session', navigateListener);
    window.removeEventListener('CHAT_NEW_SESSION', newSessionListener);
    resetChatNavigationHandshakeForTest();
  });

  it('notifies the shell and queues session navigation while the page is not ready', () => {
    requestChatSessionNavigation('sess_cold');

    expect(navigateListener).toHaveBeenCalledTimes(1);
    const event = navigateListener.mock.calls[0][0] as CustomEvent<{ sessionId: string }>;
    expect(event.detail.sessionId).toBe('sess_cold');
    expect(peekPendingChatNavigation()).toEqual({ kind: 'session', sessionId: 'sess_cold' });
  });

  it('keeps only the latest pending intent', () => {
    requestChatSessionNavigation('sess_first');
    requestChatSessionNavigation('sess_second');

    expect(peekPendingChatNavigation()).toEqual({ kind: 'session', sessionId: 'sess_second' });
  });

  it('replays the pending intent once when the page becomes ready', () => {
    requestChatSessionNavigation('sess_target');

    const release = markChatPageReady();

    expect(isChatPageReady()).toBe(true);
    expect(navigateListener).toHaveBeenCalledTimes(2);
    const event = navigateListener.mock.calls[1][0] as CustomEvent<{ sessionId: string }>;
    expect(event.detail.sessionId).toBe('sess_target');
    expect(peekPendingChatNavigation()).toBeNull();

    release();
    expect(isChatPageReady()).toBe(false);
  });

  it('dispatches immediately while ready, without touching the queue', () => {
    const release = markChatPageReady();
    requestChatSessionNavigation('sess_live');

    expect(navigateListener).toHaveBeenCalledTimes(1);
    expect(peekPendingChatNavigation()).toBeNull();
    release();
  });

  it('drops a pending intent when the user switches sessions manually', () => {
    requestChatSessionNavigation('sess_auto');
    invalidatePendingChatNavigation();

    markChatPageReady()();
    // 仅保留请求时供壳层开窗的首次事件；ready 后不再重放。
    expect(navigateListener).toHaveBeenCalledTimes(1);
  });

  it('still dispatches CHAT_NEW_SESSION while not ready so the shell can open the page', () => {
    requestChatNewSession();

    // 事件照发（壳层监听者开窗/切视图），意图同时挂起等待页面消费
    expect(newSessionListener).toHaveBeenCalledTimes(1);
    expect(peekPendingChatNavigation()).toEqual({ kind: 'new-session' });
  });

  it('replays a pending new-session intent as CHAT_NEW_SESSION on ready', () => {
    requestChatNewSession();
    newSessionListener.mockClear();

    markChatPageReady();
    expect(newSessionListener).toHaveBeenCalledTimes(1);
    expect(peekPendingChatNavigation()).toBeNull();
  });

  it('a mounted-but-loading page listener can consume the event and clear the queue synchronously', () => {
    // 模拟 useChatPageEvents 的 CHAT_NEW_SESSION 监听：直接消费并作废 pending
    const consumer = vi.fn(() => invalidatePendingChatNavigation());
    window.addEventListener('CHAT_NEW_SESSION', consumer);
    try {
      requestChatNewSession();
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(peekPendingChatNavigation()).toBeNull();

      // 就绪后不再重放（不会重复建会话）
      markChatPageReady();
      expect(consumer).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('CHAT_NEW_SESSION', consumer);
    }
  });

  it('release is idempotent and supports overlapping consumers', () => {
    const releaseA = markChatPageReady();
    const releaseB = markChatPageReady();
    releaseA();
    releaseA();
    expect(isChatPageReady()).toBe(true);
    releaseB();
    expect(isChatPageReady()).toBe(false);
  });

  it('a later navigation intent supersedes a pending new-session intent', () => {
    requestChatNewSession();
    requestChatSessionNavigation('sess_from_bridge');

    expect(peekPendingChatNavigation()).toEqual({
      kind: 'session',
      sessionId: 'sess_from_bridge',
    });
  });
});
