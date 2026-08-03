/**
 * ACR R2-10 — browser ControlMode 前端镜像与 Rust 权威事件对齐
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hubListenMock = vi.hoisted(() => vi.fn());
const getBrowserStateMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/workbench/core/eventHub', () => ({
  hubListen: hubListenMock,
}));

vi.mock('../browserApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browserApi')>();
  return {
    ...actual,
    getState: getBrowserStateMock,
    navigate: navigateMock,
  };
});

import {
  __applyControlModePayloadForTest,
  __applyNavigatedPayloadForTest,
  __applyNavigationBlockedPayloadForTest,
  __applyTitlePayloadForTest,
  __applyClosedPayloadForTest,
  __resetControlModeSyncForTest,
  BROWSER_CLOSED_EVENT,
  BROWSER_NAVIGATED_EVENT,
  BROWSER_NAVIGATION_BLOCKED_EVENT,
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
    navigateMock.mockReset();
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
      BROWSER_NAVIGATION_BLOCKED_EVENT,
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

  it('navigation-blocked 结束 loading 并显示明确错误', () => {
    useBrowserSessionStore.setState({
      loading: true,
      lastError: null,
      error: null,
    });

    __applyNavigationBlockedPayloadForTest({
      sessionId: 'sess-br-1',
      url: 'http://example.com/',
      reason: 'http navigation is limited to loopback hosts',
    });

    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: 'sess-br-1',
      loading: false,
      lastError: '导航被阻止：http navigation is limited to loopback hosts',
      error: '导航被阻止：http navigation is limited to loopback hosts',
    });
  });

  it('navigation-blocked 使迟到的成功命令回执失效并恢复权威 URL/历史', async () => {
    let resolveNavigate!: (snapshot: ReturnType<typeof getBrowserStateMock>) => void;
    const commandResponse = new Promise((resolve) => {
      resolveNavigate = resolve;
    });
    navigateMock.mockReturnValue(commandResponse);
    const rollbackSnapshot = {
      sessionId: 'sess-br-1',
      currentUrl: 'https://allowed.example/',
      title: 'Allowed',
      canGoBack: false,
      canGoForward: true,
      controlMode: 'user',
      loading: false,
      history: [
        { url: 'https://allowed.example/', title: 'Allowed', visitedAt: null },
        { url: 'https://forward.example/', title: 'Forward', visitedAt: null },
      ],
      historyIndex: 0,
      agentAutomationSupported: true,
      error: null,
    };
    getBrowserStateMock.mockResolvedValue(rollbackSnapshot);
    useBrowserSessionStore.setState({
      currentUrl: rollbackSnapshot.currentUrl,
      addressDraft: 'http://blocked.example/',
      title: rollbackSnapshot.title,
      history: rollbackSnapshot.history,
      historyIndex: rollbackSnapshot.historyIndex,
      canGoForward: true,
      loading: false,
    });

    const navigation = useBrowserSessionStore.getState().navigate('http://blocked.example/', {
      forceUserControl: false,
    });
    __applyNavigationBlockedPayloadForTest({
      sessionId: 'sess-br-1',
      url: 'http://blocked.example/',
      reason: 'blocked redirect',
      currentUrl: rollbackSnapshot.currentUrl,
      title: rollbackSnapshot.title,
      canGoBack: false,
      canGoForward: true,
      historyIndex: 0,
    });
    resolveNavigate({
      ...rollbackSnapshot,
      currentUrl: 'http://blocked.example/',
      history: [
        ...rollbackSnapshot.history,
        { url: 'http://blocked.example/', title: 'Blocked', visitedAt: null },
      ],
      historyIndex: 2,
    });
    await navigation;

    await vi.waitFor(() => {
      expect(useBrowserSessionStore.getState()).toMatchObject({
        currentUrl: 'https://allowed.example/',
        addressDraft: 'https://allowed.example/',
        historyIndex: 0,
        canGoForward: true,
      });
    });
    expect(useBrowserSessionStore.getState().history).toHaveLength(2);
  });

  it('忽略异 session 与已关闭 session 的 navigation-blocked 事件', () => {
    useBrowserSessionStore.setState({ loading: true, lastError: null, error: null });
    __applyNavigationBlockedPayloadForTest({
      sessionId: 'other-sess',
      reason: 'blocked other session',
    });
    expect(useBrowserSessionStore.getState()).toMatchObject({
      loading: true,
      lastError: null,
      error: null,
    });

    __applyClosedPayloadForTest({ sessionId: 'sess-br-1', reason: 'destroyed' });
    __applyNavigationBlockedPayloadForTest({
      sessionId: 'sess-br-1',
      reason: 'late block',
    });
    expect(useBrowserSessionStore.getState()).toMatchObject({
      sessionId: null,
      loading: false,
      lastError: null,
      error: null,
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
