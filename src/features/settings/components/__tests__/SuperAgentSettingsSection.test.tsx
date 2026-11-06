import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const api = vi.hoisted(() => ({ getState: vi.fn(), setEnabled: vi.fn(), getSettings: vi.fn() }));
// 状态 store 与额外指令面板直接 invoke 契约命令：按命令名分派到 api 桩。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: { enabled?: boolean }) => {
    if (cmd === 'super_session_get_state') return api.getState();
    if (cmd === 'super_session_set_enabled') return api.setEnabled(args?.enabled);
    if (cmd === 'super_session_get_settings') return api.getSettings();
    return Promise.reject(new Error('unexpected command ' + cmd));
  },
}));

import { createNavItems } from '@/config/navigation';
import { useSuperAgentEnabledStore } from '@/stores/superAgentEnabledStore';
import { SuperAgentSettingsSection } from '../SuperAgentSettingsSection';

const t = ((key: string, def?: string) => def ?? key) as never;

describe('Super-agent session switch (Settings → Automation)', () => {
  beforeEach(() => {
    localStorage.clear();
    api.getState.mockReset();
    api.setEnabled.mockReset();
    api.getSettings.mockReset();
    api.getSettings.mockResolvedValue({ instructions: '' });
    useSuperAgentEnabledStore.setState({ enabled: false, sessionId: null, synced: false });
  });
  afterEach(() => cleanup());

  it('defaults to disabled', () => {
    expect(useSuperAgentEnabledStore.getState().enabled).toBe(false);
    expect(useSuperAgentEnabledStore.getState().sessionId).toBeNull();
  });

  it('never adds a separate super-agent navigation entry', () => {
    const views = createNavItems(t).map((i) => i.view);
    expect(views).not.toContain('super-agent');
    expect(views).toEqual(['chat-v2', 'learning-hub', 'notes', 'media', 'todo', 'skills-management', 'flashcards', 'settings']);
    expect(createNavItems(t, true).map((i) => i.view)).not.toContain('super-agent');
  });

  it('the switch writes the backend first, then mirrors {enabled, sessionId} and refreshes the session list', async () => {
    api.getState.mockResolvedValue({ enabled: false, sessionId: null, workspaceId: null, pendingInbox: 0 });
    api.setEnabled.mockResolvedValue({ enabled: true, sessionId: 'sess_super', workspaceId: 'ws_1', pendingInbox: 0 });
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const sessionsUpdatedDispatched = () =>
      dispatchSpy.mock.calls.some(([event]) => event.type === 'chat-v2:sessions-updated');
    try {
      render(<SuperAgentSettingsSection />);
      fireEvent.click(await screen.findByRole('switch'));
      await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(true));
      await waitFor(() => expect(useSuperAgentEnabledStore.getState().enabled).toBe(true));
      expect(useSuperAgentEnabledStore.getState().sessionId).toBe('sess_super');
      expect(localStorage.getItem('ds.superAgent.enabled')).toBe('1');
      expect(localStorage.getItem('ds.superAgent.sessionId')).toBe('sess_super');
      expect(sessionsUpdatedDispatched()).toBe(true);
      // 启用后出现额外指令面板
      expect(await screen.findByLabelText('config.instructionsTitle')).toBeInTheDocument();
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it('does not flip the mirror when the backend call fails', async () => {
    api.getState.mockResolvedValue({ enabled: false, sessionId: null });
    api.setEnabled.mockRejectedValue(new Error('boom'));
    render(<SuperAgentSettingsSection />);
    fireEvent.click(await screen.findByRole('switch'));
    await screen.findByText(/boom/);
    expect(useSuperAgentEnabledStore.getState().enabled).toBe(false);
  });

  it('corrects a stale cached "on" from the backend truth', async () => {
    useSuperAgentEnabledStore.setState({ enabled: true, sessionId: 'old', synced: false });
    api.getState.mockResolvedValue({ enabled: false, sessionId: null });
    await useSuperAgentEnabledStore.getState().syncFromBackend();
    expect(useSuperAgentEnabledStore.getState().enabled).toBe(false);
    expect(useSuperAgentEnabledStore.getState().sessionId).toBeNull();
  });

  it('keeps the cached value when the backend is unavailable', async () => {
    useSuperAgentEnabledStore.setState({ enabled: true, sessionId: 'cached', synced: false });
    api.getState.mockRejectedValue(new Error('no backend'));
    await useSuperAgentEnabledStore.getState().syncFromBackend();
    expect(useSuperAgentEnabledStore.getState().enabled).toBe(true);
    expect(useSuperAgentEnabledStore.getState().sessionId).toBe('cached');
  });

  it('refresh() picks up the replacement session after the Super session is deleted', async () => {
    useSuperAgentEnabledStore.setState({ enabled: true, sessionId: 'deleted', synced: true });
    api.getState.mockResolvedValue({ enabled: true, sessionId: 'fresh' });
    await expect(useSuperAgentEnabledStore.getState().refresh()).resolves.toEqual({ enabled: true, sessionId: 'fresh' });
    expect(useSuperAgentEnabledStore.getState().sessionId).toBe('fresh');
  });
});
