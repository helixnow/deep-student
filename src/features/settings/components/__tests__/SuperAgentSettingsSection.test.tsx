import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const api = vi.hoisted(() => ({ status: vi.fn(), setEnabled: vi.fn() }));
// 启用状态 store 直接 invoke 两条命令：按命令名分派到 api 桩。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: { enabled?: boolean }) => {
    if (cmd === 'superagent_status') return api.status();
    if (cmd === 'superagent_set_enabled') return api.setEnabled(args?.enabled);
    return Promise.reject(new Error('unexpected command ' + cmd));
  },
}));

import { createNavItems } from '@/config/navigation';
import { useSuperAgentEnabledStore } from '@/stores/superAgentEnabledStore';
import { SuperAgentSettingsSection } from '../SuperAgentSettingsSection';

const t = ((key: string, def?: string) => def ?? key) as never;

describe('Super-agent is off by default and only enabled from Settings', () => {
  beforeEach(() => {
    localStorage.clear();
    api.status.mockReset();
    api.setEnabled.mockReset();
    useSuperAgentEnabledStore.setState({ enabled: false, synced: false });
  });
  afterEach(() => cleanup());

  it('defaults to disabled and the sidebar has no Super-agent entry', () => {
    expect(useSuperAgentEnabledStore.getState().enabled).toBe(false);
    const views = createNavItems(t).map((i) => i.view);
    expect(views).not.toContain('super-agent');
    // 其余导航项保持原样
    expect(views).toEqual(['chat-v2', 'learning-hub', 'media', 'todo', 'skills-management', 'flashcards', 'settings']);
  });

  it('adds the entry only when explicitly enabled, without disturbing the others', () => {
    const base = createNavItems(t).map((i) => i.view);
    const withSa = createNavItems(t, false, true).map((i) => i.view);
    expect(withSa).toContain('super-agent');
    expect(withSa.filter((v) => v !== 'super-agent')).toEqual(base);
  });

  it('the settings switch writes the backend first, then the mirror', async () => {
    api.status.mockResolvedValue({ enabled: false });
    api.setEnabled.mockResolvedValue(undefined);
    render(<SuperAgentSettingsSection />);
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(true));
    await waitFor(() => expect(useSuperAgentEnabledStore.getState().enabled).toBe(true));
    expect(localStorage.getItem('ds.superAgent.enabled')).toBe('1');
  });

  it('does not flip the mirror when the backend call fails', async () => {
    api.status.mockResolvedValue({ enabled: false });
    api.setEnabled.mockRejectedValue(new Error('boom'));
    render(<SuperAgentSettingsSection />);
    fireEvent.click(await screen.findByRole('switch'));
    await screen.findByText(/boom/);
    expect(useSuperAgentEnabledStore.getState().enabled).toBe(false);
  });

  it('corrects a stale cached "on" from the backend truth', async () => {
    useSuperAgentEnabledStore.setState({ enabled: true, synced: false });
    api.status.mockResolvedValue({ enabled: false });
    await useSuperAgentEnabledStore.getState().syncFromBackend();
    expect(useSuperAgentEnabledStore.getState().enabled).toBe(false);
  });

  it('keeps the cached value when the backend is unavailable', async () => {
    useSuperAgentEnabledStore.setState({ enabled: true, synced: false });
    api.status.mockRejectedValue(new Error('no backend'));
    await useSuperAgentEnabledStore.getState().syncFromBackend();
    expect(useSuperAgentEnabledStore.getState().enabled).toBe(true);
  });
});
