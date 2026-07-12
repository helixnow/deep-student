import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, settings } = vi.hoisted(() => {
  const settings = new Map<string, string>();
  const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_setting') return settings.get(String(args?.key)) ?? null;
    if (command === 'save_setting') {
      settings.set(String(args?.key), String(args?.value));
      return null;
    }
    return null;
  });
  return { invokeMock, settings };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { workbenchBus } from '../../core/workbenchBus';
import {
  AGENT_CONTROL_DISCOVERY_SEEN_KEY,
  AGENT_CONTROL_SETTING_KEY,
  AgentControlDockEntry,
} from '../AgentControlCenter';

describe('AgentControlDockEntry', () => {
  beforeEach(() => {
    settings.clear();
    invokeMock.mockClear();
    localStorage.removeItem(AGENT_CONTROL_DISCOVERY_SEEN_KEY);
  });

  it('is a permanent Dock entry and reveals concrete capabilities plus safety limits', async () => {
    settings.set(AGENT_CONTROL_SETTING_KEY, 'background');
    render(<AgentControlDockEntry tabIndex={0} />);

    const trigger = screen.getByTestId('wb-dock-agent-control-button');
    await waitFor(() => expect(trigger).toHaveAttribute('data-mode', 'background'));
    expect(trigger).toHaveAttribute('data-unseen', 'true');

    fireEvent.click(trigger);

    expect(await screen.findByRole('dialog', { name: 'AI 桌面操控' })).toBeInTheDocument();
    expect(screen.getByText('可操控的学习应用')).toBeInTheDocument();
    expect(document.querySelectorAll('.wb-agent-capability-row')).toHaveLength(8);
    expect(
      screen.getByText(/不会替你答题、提交考试或给闪卡评分/),
    ).toBeInTheDocument();
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
});
