/**
 * ACR R2-10 — browser ControlMode 前端镜像与 Rust 权威事件对齐
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hubListenMock = vi.hoisted(() => vi.fn());
const getBrowserStateMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/workbench/core/eventHub', () => ({
  hubListen: hubListenMock,
}));

vi.mock('../browserApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browserApi')>();
  return {
    ...actual,
    getState: getBrowserStateMock,
  };
});

import {
  __applyControlModePayloadForTest,
  __applyNavigatedPayloadForTest,
  __applyTitlePayloadForTest,
  __applyClosedPayloadForTest,
  __resetControlModeSyncForTest,
  BROWSER_CLOSED_EVENT,
  BROWSER_NAVIGATED_EVENT,
  BROWSER_TITLE_CHANGED_EVENT,
  ensureBrowserControlModeSync,
} from '../controlModeSync';
import {
  INITIAL_BROWSER_SESSION_STATE,
  useBrowserSessionStore,
} from '../sessionStore';

describe('browser controlModeSync R2-10', () => {
  beforeEach(() => {
    __resetControlModeSyncForTest();
    hubListenMock.mockReset();
    hubListenMock.mockReturnValue(() => {});
    getBrowserStateMock.mockReset();
    getBrowserStateMock.mockResolvedValue({
      sessionId: 'sess-br-1',
      currentUrl: 'https://example.com/final',
      title: 'Final',
      canGoBack: true,
      canGoForward: false,
      controlMode: 'agent',
      loading: false,
      history: [
        { url: 'https://example.com', title: 'Example', visitedAt: '2026-07-11T00:00:00Z' },
        { url: 'https://example.com/final', title: 'Final', visitedAt: '2026-07-11T00:01:00Z' },
      ],
      historyIndex: 1,
      agentAutomationSupported: true,
      error: null,
    });
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      sessionId: 'sess-br-1',
      controlMode: 'agent',
    });
  });

  it('经 eventHub 单入口订阅 control/navigation/title/closed 权威事件', () => {
    const dispose = ensureBrowserControlModeSync();
    expect(hubListenMock.mock.calls.map(([event]) => event)).toEqual([
      'browser:control-mode-changed',
      BROWSER_NAVIGATED_EVENT,
      BROWSER_TITLE_CHANGED_EVENT,
      BROWSER_CLOSED_EVENT,
    ]);
    dispose();
  });

  it('权威事件 user_takeover → 镜像 controlMode=user', () => {
    __applyControlModePayloadForTest({
      sessionId: 'sess-br-1',
      controlMode: 'user',
      reason: 'user_takeover',
    });
    expect(useBrowserSessionStore.getState().controlMode).toBe('user');
  });

  it('权威事件 agent_claim → 镜像 controlMode=agent', () => {
    useBrowserSessionStore.setState({ controlMode: 'user' });
    __applyControlModePayloadForTest({
      session_id: 'sess-br-1',
      control_mode: 'Agent',
      reason: 'agent_claim',
    });
    expect(useBrowserSessionStore.getState().controlMode).toBe('agent');
  });

  it('异 sessionId 的事件不污染当前镜像', () => {
    __applyControlModePayloadForTest({
      sessionId: 'other-sess',
      controlMode: 'user',
      reason: 'user_takeover',
    });
    expect(useBrowserSessionStore.getState().controlMode).toBe('agent');
  });

  it('navigated 立即同步 URL，再以 get_state 回执补齐 history', async () => {
    useBrowserSessionStore.setState({
      currentUrl: 'https://example.com',
      addressDraft: 'https://example.com',
      history: [],
      historyIndex: -1,
    });
    __applyNavigatedPayloadForTest({
      sessionId: 'sess-br-1',
      url: 'https://example.com/final',
      title: 'Loading',
      canGoBack: true,
      canGoForward: false,
      loading: false,
    });
    expect(useBrowserSessionStore.getState().currentUrl).toBe('https://example.com/final');
    expect(useBrowserSessionStore.getState().addressDraft).toBe('https://example.com/final');

    await vi.waitFor(() => {
      expect(useBrowserSessionStore.getState().history).toHaveLength(2);
      expect(useBrowserSessionStore.getState().historyIndex).toBe(1);
    });
  });

  it('title/closed 事件同步标题并清空已销毁 session', () => {
    useBrowserSessionStore.setState({
      history: [{ url: 'https://example.com', title: 'Old title' }],
      historyIndex: 0,
    });
    __applyTitlePayloadForTest({ sessionId: 'sess-br-1', title: 'Updated title' });
    expect(useBrowserSessionStore.getState().title).toBe('Updated title');
    expect(useBrowserSessionStore.getState().history[0]?.title).toBe('Updated title');
    expect(getBrowserStateMock).not.toHaveBeenCalled();

    __applyClosedPayloadForTest({ sessionId: 'sess-br-1', reason: 'destroyed' });
    expect(useBrowserSessionStore.getState().sessionId).toBeNull();
    expect(useBrowserSessionStore.getState().contentVisible).toBe(false);
  });

  it('closed 后忽略同一 session 迟到的 navigation/title 事件', () => {
    __applyClosedPayloadForTest({ sessionId: 'sess-br-1', reason: 'destroyed' });
    __applyNavigatedPayloadForTest({
      sessionId: 'sess-br-1',
      url: 'https://example.com/late',
    });
    __applyTitlePayloadForTest({ sessionId: 'sess-br-1', title: 'Late title' });

    const state = useBrowserSessionStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.currentUrl).toBe('');
    expect(state.title).toBe('');
  });

  it('连续关闭 A/B 后仍忽略迟到的 A navigation/title/control 事件', () => {
    __applyClosedPayloadForTest({ sessionId: 'sess-br-1', reason: 'destroyed' });
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      sessionId: 'sess-br-2',
      currentUrl: 'https://b.example',
      title: 'B',
      controlMode: 'agent',
    });
    __applyClosedPayloadForTest({ sessionId: 'sess-br-2', reason: 'destroyed' });

    __applyNavigatedPayloadForTest({
      sessionId: 'sess-br-1',
      url: 'https://a.example/late',
      title: 'Late A',
    });
    __applyTitlePayloadForTest({ sessionId: 'sess-br-1', title: 'Later A' });
    __applyControlModePayloadForTest({ sessionId: 'sess-br-1', controlMode: 'agent' });

    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: null,
      currentUrl: '',
      title: '',
      controlMode: 'user',
      contentVisible: false,
    });
    expect(getBrowserStateMock).not.toHaveBeenCalled();
  });
});
