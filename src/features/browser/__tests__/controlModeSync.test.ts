/**
 * ACR R2-10 — browser ControlMode 前端镜像与 Rust 权威事件对齐
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hubListenMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/workbench/core/eventHub', () => ({
  hubListen: hubListenMock,
}));

import {
  __applyControlModePayloadForTest,
  __resetControlModeSyncForTest,
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
    useBrowserSessionStore.setState({
      ...INITIAL_BROWSER_SESSION_STATE,
      sessionId: 'sess-br-1',
      controlMode: 'agent',
    });
  });

  it('ensureBrowserControlModeSync 经 hubListen 订阅 browser:control-mode-changed', () => {
    const dispose = ensureBrowserControlModeSync();
    expect(hubListenMock).toHaveBeenCalledWith(
      'browser:control-mode-changed',
      expect.any(Function),
    );
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
});
