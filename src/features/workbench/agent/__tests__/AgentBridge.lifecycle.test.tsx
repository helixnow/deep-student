import React, { StrictMode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workbenchBus } from '../../core/workbenchBus';

const mocks = vi.hoisted(() => ({
  setupAgentBridge: vi.fn(),
  startStageManager: vi.fn(),
  stopStageManager: vi.fn(),
}));

vi.mock('../bridge', () => ({
  setupAgentBridge: mocks.setupAgentBridge,
}));

vi.mock('../stageManager', () => ({
  stageManager: {
    start: mocks.startStageManager,
    stop: mocks.stopStageManager,
  },
}));

import { AgentBridge } from '../AgentBridge';

describe('AgentBridge global lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workbenchBus.setEnabled(false);
    mocks.setupAgentBridge.mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    cleanup();
    workbenchBus.setEnabled(false);
    vi.restoreAllMocks();
  });

  it('keeps the control bridge mounted while desktop availability changes', () => {
    const teardown = vi.fn();
    const setEnabled = vi.spyOn(workbenchBus, 'setEnabled');
    mocks.setupAgentBridge.mockReturnValueOnce(teardown);

    const view = render(<AgentBridge workbenchActive={false} />);
    expect(workbenchBus.isEnabled()).toBe(false);
    expect(mocks.startStageManager).not.toHaveBeenCalled();
    expect(mocks.setupAgentBridge).toHaveBeenCalledTimes(1);

    setEnabled.mockClear();
    view.rerender(<AgentBridge workbenchActive />);
    expect(workbenchBus.isEnabled()).toBe(true);
    expect(mocks.startStageManager).toHaveBeenCalledTimes(1);
    expect(mocks.startStageManager.mock.invocationCallOrder.at(-1)).toBeLessThan(
      setEnabled.mock.invocationCallOrder.at(-1)!,
    );
    expect(mocks.setupAgentBridge).toHaveBeenCalledTimes(1);

    const busCallsBeforeDisable = setEnabled.mock.calls.length;
    view.rerender(<AgentBridge workbenchActive={false} />);
    expect(workbenchBus.isEnabled()).toBe(false);
    expect(teardown).not.toHaveBeenCalled();
    expect(mocks.stopStageManager).toHaveBeenCalledTimes(1);
    expect(setEnabled.mock.invocationCallOrder[busCallsBeforeDisable]).toBeLessThan(
      mocks.stopStageManager.mock.invocationCallOrder.at(-1)!,
    );

    view.rerender(<AgentBridge workbenchActive />);
    expect(workbenchBus.isEnabled()).toBe(true);
    expect(mocks.startStageManager).toHaveBeenCalledTimes(2);
    expect(mocks.startStageManager.mock.invocationCallOrder.at(-1)).toBeLessThan(
      setEnabled.mock.invocationCallOrder.at(-1)!,
    );
    expect(mocks.setupAgentBridge).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(mocks.stopStageManager).toHaveBeenCalledTimes(2);
  });

  it('balances setup and teardown under StrictMode remount checks', () => {
    const teardowns: Array<ReturnType<typeof vi.fn>> = [];
    mocks.setupAgentBridge.mockImplementation(() => {
      const teardown = vi.fn();
      teardowns.push(teardown);
      return teardown;
    });

    const view = render(
      <StrictMode>
        <AgentBridge workbenchActive />
      </StrictMode>,
    );
    expect(workbenchBus.isEnabled()).toBe(true);

    view.unmount();
    expect(mocks.setupAgentBridge.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mocks.startStageManager).toHaveBeenCalledTimes(mocks.setupAgentBridge.mock.calls.length);
    expect(mocks.stopStageManager).toHaveBeenCalledTimes(mocks.setupAgentBridge.mock.calls.length);
    expect(teardowns.every((teardown) => teardown.mock.calls.length === 1)).toBe(true);
    expect(workbenchBus.isEnabled()).toBe(false);
  });
});
