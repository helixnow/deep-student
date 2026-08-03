import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, settings, listenMock, killSwitchListeners } = vi.hoisted(() => {
  const settings = new Map<string, string>();
  const killSwitchListeners: Array<(event: { payload: unknown }) => void> = [];
  const invokeMock = vi.fn();
  const listenMock = vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    killSwitchListeners.push(handler);
    return () => {
      const index = killSwitchListeners.indexOf(handler);
      if (index >= 0) killSwitchListeners.splice(index, 1);
    };
  });
  return { invokeMock, settings, listenMock, killSwitchListeners };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

import { workbenchBus } from '../../core/workbenchBus';
import {
  AGENT_CONTROL_DISCOVERY_SEEN_KEY,
  AGENT_CONTROL_SETTING_KEY,
  AgentControlDockEntry,
  KILL_SWITCH_CHANGED_EVENT,
} from '../AgentControlCenter';

const defaultInvokeImpl = async (command: string, args?: Record<string, unknown>) => {
  if (command === 'get_setting') return settings.get(String(args?.key)) ?? null;
  if (command === 'save_setting') {
    settings.set(String(args?.key), String(args?.value));
    return null;
  }
  if (command === 'chat_v2_kill_switch_status') {
    return { tripped: false, automationsPaused: false };
  }
  if (command === 'chat_v2_emergency_stop') {
    return {
      tripped: true,
      reason: 'user_emergency_stop',
      automationsPaused: true,
      cancelledStreams: 2,
    };
  }
  if (command === 'chat_v2_resume_agents') {
    return { tripped: false, automationsPaused: true };
  }
  if (command === 'chat_v2_resume_automations') {
    return { tripped: false, automationsPaused: false };
  }
  return null;
};

describe('AgentControlDockEntry', () => {
  beforeEach(() => {
    settings.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(defaultInvokeImpl);
    listenMock.mockClear();
    killSwitchListeners.length = 0;
    localStorage.removeItem(AGENT_CONTROL_DISCOVERY_SEEN_KEY);
  });

  it('is a permanent Dock entry with a compact summary and expandable safety-bounded capabilities', async () => {
    settings.set(AGENT_CONTROL_SETTING_KEY, 'background');
    render(<AgentControlDockEntry tabIndex={0} />);

    const trigger = screen.getByTestId('wb-dock-agent-control-button');
    await waitFor(() => expect(trigger).toHaveAttribute('data-mode', 'background'));
    expect(trigger).toHaveAttribute('data-unseen', 'true');
    expect(trigger).toHaveClass('h-11', 'w-11', 'wb-dock-item');
    expect(trigger.querySelector('img')).toHaveAttribute('src', '/app-icon.png');
    expect(trigger.querySelector('.wb-agent-control-status-dot')).not.toBeInTheDocument();
    expect(trigger.querySelector('.wb-agent-control-new-dot')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'AI 桌面操控' });
    expect(dialog).toHaveClass('wb-glass', 'wb-glass-highlight', 'wb-glass-lens');
    expect(dialog.querySelector('.wb-agent-control-mark img')).toHaveAttribute('src', '/app-icon.png');
    expect(screen.getByText('能做什么')).toBeInTheDocument();
    expect(document.querySelectorAll('.wb-agent-capability-group')).toHaveLength(3);
    expect(document.querySelectorAll('.wb-agent-capability-row')).toHaveLength(0);
    expect(screen.getByText('整理内容')).toBeInTheDocument();
    expect(screen.getByText('推进学习')).toBeInTheDocument();
    expect(screen.getByText('查找资料')).toBeInTheDocument();
    expect(screen.getByText(/不会代答、提交或评分/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '全部能力' }));
    expect(document.querySelectorAll('.wb-agent-capability-row')).toHaveLength(8);
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem(AGENT_CONTROL_DISCOVERY_SEEN_KEY)).toBe('1');
  });

  it('changes off/background/follow mode from the popover and broadcasts the setting', async () => {
    settings.set(AGENT_CONTROL_SETTING_KEY, 'follow');
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    try {
      render(<AgentControlDockEntry tabIndex={0} />);
      const trigger = screen.getByTestId('wb-dock-agent-control-button');
      await waitFor(() => expect(trigger).toHaveAttribute('data-mode', 'follow'));
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('radio', { name: '关闭' }));

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('save_setting', {
          key: AGENT_CONTROL_SETTING_KEY,
          value: 'off',
        });
      });
      expect(trigger).toHaveAttribute('data-mode', 'off');
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'workbench:settings-changed' }),
      );
    } finally {
      dispatch.mockRestore();
    }
  });

  it('provides direct Chat and settings entry points', async () => {
    const activate = vi.spyOn(workbenchBus, 'activate').mockResolvedValue(true);
    const launch = vi.spyOn(workbenchBus, 'launch').mockReturnValue('settings-window');
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    try {
      render(<AgentControlDockEntry tabIndex={0} />);
      const trigger = screen.getByTestId('wb-dock-agent-control-button');
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('button', { name: /打开 Chat/ }));
      expect(activate).toHaveBeenCalledWith({
        typeId: 'chat',
        instanceKey: '',
        action: 'focusInput',
        fallbackLaunch: { typeId: 'chat', reason: 'dock' },
      });

      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('button', { name: /操控设置/ }));
      expect(launch).toHaveBeenCalledWith({ typeId: 'settings', reason: 'dock' });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SETTINGS_NAVIGATE_TAB' }),
      );
    } finally {
      activate.mockRestore();
      launch.mockRestore();
      dispatch.mockRestore();
    }
  });

  it('invokes emergency stop with reason and shows assertive kill-switch banner', async () => {
    let resolveStop!: (value: unknown) => void;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_setting') return settings.get(String(args?.key)) ?? null;
      if (command === 'chat_v2_kill_switch_status') {
        return { tripped: false, automationsPaused: false };
      }
      if (command === 'chat_v2_emergency_stop') {
        return await new Promise((resolve) => {
          resolveStop = resolve;
        });
      }
      return null;
    });

    render(<AgentControlDockEntry tabIndex={0} />);
    fireEvent.click(screen.getByTestId('wb-dock-agent-control-button'));

    fireEvent.click(await screen.findByTestId('wb-agent-emergency-stop'));
    fireEvent.click(await screen.findByTestId('wb-agent-emergency-stop-confirm'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_emergency_stop', {
        reason: 'user_emergency_stop',
      });
    });
    expect(screen.getByTestId('wb-agent-kill-switch')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('wb-agent-emergency-stop-confirm')).toBeDisabled();

    resolveStop({
      tripped: true,
      reason: 'user_emergency_stop',
      automationsPaused: true,
      cancelledStreams: 2,
    });

    const banner = await screen.findByTestId('wb-agent-kill-switch-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'assertive');
    expect(banner).toHaveTextContent(/断电|powered off|Agents are powered off/i);
    expect(screen.getByTestId('wb-dock-agent-control-button')).toHaveAttribute(
      'data-kill-switch',
      'tripped',
    );
    expect(screen.getByTestId('wb-agent-kill-switch-dock-badge')).toHaveAttribute(
      'data-state',
      'tripped',
    );
    await waitFor(() => {
      expect(screen.getByTestId('wb-agent-kill-switch')).not.toHaveAttribute('aria-busy');
    });
  });

  it('resume agents keeps automations paused, then resume_automations clears pause', async () => {
    render(<AgentControlDockEntry tabIndex={0} />);
    fireEvent.click(screen.getByTestId('wb-dock-agent-control-button'));

    fireEvent.click(await screen.findByTestId('wb-agent-emergency-stop'));
    fireEvent.click(await screen.findByTestId('wb-agent-emergency-stop-confirm'));
    await screen.findByTestId('wb-agent-kill-switch-banner');

    fireEvent.click(await screen.findByTestId('wb-agent-resume-agents'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_resume_agents');
    });

    const pausedBanner = await screen.findByTestId('wb-agent-kill-switch-banner');
    expect(pausedBanner).toHaveTextContent(/自动化仍处于暂停|still paused/i);
    expect(screen.getByTestId('wb-dock-agent-control-button')).not.toHaveAttribute(
      'data-kill-switch',
    );
    expect(screen.getByTestId('wb-agent-kill-switch-dock-badge')).toHaveAttribute(
      'data-state',
      'paused',
    );

    fireEvent.click(await screen.findByTestId('wb-agent-resume-automations'));
    fireEvent.click(await screen.findByTestId('wb-agent-resume-automations-confirm'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_resume_automations');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('wb-agent-kill-switch-banner')).not.toBeInTheDocument();
    });
  });

  it('syncs dock badge and banner from kill_switch_changed events (snake_case payload)', async () => {
    render(<AgentControlDockEntry tabIndex={0} />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith(
        KILL_SWITCH_CHANGED_EVENT,
        expect.any(Function),
      );
    });

    killSwitchListeners[0]?.({
      payload: {
        tripped: true,
        tripped_at_ms: 1_700_000_000_000,
        reason: 'external_trip',
        automations_paused: true,
        cancelled_streams: 1,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('wb-dock-agent-control-button')).toHaveAttribute(
        'data-kill-switch',
        'tripped',
      );
    });
    expect(screen.getByTestId('wb-agent-kill-switch-dock-badge')).toHaveAttribute(
      'data-state',
      'tripped',
    );
    expect(screen.getByTestId('wb-dock-agent-control-button').getAttribute('aria-label')).toMatch(
      /断电|powered off/i,
    );

    fireEvent.click(screen.getByTestId('wb-dock-agent-control-button'));
    const banner = await screen.findByTestId('wb-agent-kill-switch-banner');
    expect(banner).toHaveTextContent(/external_trip/);
  });

  it('hydrates tripped status from chat_v2_kill_switch_status on mount', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_setting') return settings.get(String(args?.key)) ?? null;
      if (command === 'chat_v2_kill_switch_status') {
        return {
          tripped: true,
          reason: 'persisted_trip',
          automationsPaused: true,
        };
      }
      return null;
    });

    render(<AgentControlDockEntry tabIndex={0} />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_kill_switch_status');
    });
    await waitFor(() => {
      expect(screen.getByTestId('wb-dock-agent-control-button')).toHaveAttribute(
        'data-kill-switch',
        'tripped',
      );
    });
    expect(screen.getByTestId('wb-agent-kill-switch-dock-badge')).toBeInTheDocument();
  });
});
