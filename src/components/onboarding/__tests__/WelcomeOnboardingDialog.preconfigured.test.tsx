import React from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  WelcomeOnboardingDialog,
  useWelcomeOnboarding,
  resetWelcomeOnboardingRuntimeState,
} from '../WelcomeOnboardingDialog';

describe('useWelcomeOnboarding & WelcomeOnboardingDialog preconfigured AI (W8B-10)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
    resetWelcomeOnboardingRuntimeState();
  });

  afterEach(() => {
    cleanup();
    resetWelcomeOnboardingRuntimeState();
  });

  it('opens welcome dialog in AI Ready mode for a fresh empty workspace with a preconfigured model', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_api_configurations') {
        return [{ id: 'cfg-1', name: 'DeepSeek V4.1 Flash', model: 'deepseek-flash', enabled: true }];
      }
      if (cmd === 'chat_v2_count_sessions') return 0;
      if (cmd === 'vfs_list_notes') return [];
      return [];
    });

    const { result } = renderHook(() => useWelcomeOnboarding(true));

    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    expect(result.current.aiReady).toBe(true);
    expect(result.current.preconfiguredModel).toBe('DeepSeek V4.1 Flash');
    expect(localStorage.getItem('onboarding_completed_flows')).toBeNull();

    // Even when rendered without extra props (as AppShellChrome does), picks up AI Ready state
    render(<WelcomeOnboardingDialog onConfigure={vi.fn()} onSkip={result.current.dismiss} />);
    const readyCard = screen.getByTestId('welcome-ai-ready-card');
    expect(readyCard).toBeInTheDocument();
    expect(readyCard.textContent).toContain('DeepSeek V4.1 Flash');
    expect(screen.queryByTestId('byok-provisioner-card')).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/\p{Extended_Pictographic}/u);

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.open).toBe(false);
    expect(JSON.parse(localStorage.getItem('onboarding_completed_flows') || '[]')).toContain('welcome-v1');
  });

  it('silently skips and marks completed for upgrade users who already have sessions or notes', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_api_configurations') {
        return [{ id: 'cfg-1', name: 'GPT-5.6', model: 'gpt-5.6', enabled: true }];
      }
      if (cmd === 'chat_v2_count_sessions') return 3;
      if (cmd === 'vfs_list_notes') return [];
      return [];
    });

    const { result } = renderHook(() => useWelcomeOnboarding(true));

    await waitFor(() => {
      expect(localStorage.getItem('onboarding_completed_flows')).toContain('welcome-v1');
    });
    expect(result.current.open).toBe(false);
  });

  it('silently skips for upgrade users who already have existing notes', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_api_configurations') {
        return [{ id: 'cfg-1', name: 'GPT-5.6', model: 'gpt-5.6', enabled: true }];
      }
      if (cmd === 'chat_v2_count_sessions') return 0;
      if (cmd === 'vfs_list_notes') return [{ id: 'note-1' }];
      return [];
    });

    const { result } = renderHook(() => useWelcomeOnboarding(true));

    await waitFor(() => {
      expect(localStorage.getItem('onboarding_completed_flows')).toContain('welcome-v1');
    });
    expect(result.current.open).toBe(false);
  });

  it('shows QuickByokProvisionerCard when no model is configured yet', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_api_configurations') return [];
      return [];
    });

    const { result } = renderHook(() => useWelcomeOnboarding(true));

    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    expect(result.current.aiReady).toBe(false);

    render(<WelcomeOnboardingDialog onConfigure={vi.fn()} onSkip={result.current.dismiss} />);
    expect(screen.getByTestId('byok-provisioner-card')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome-ai-ready-card')).toBeNull();
  });
});
