import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProfile, VendorConfig } from '@/types';

const { invokeMock, openUrlMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openUrlMock: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/utils/urlOpener', () => ({
  openUrl: openUrlMock,
}));

import { OpenAICodexAccountSection } from '../OpenAICodexAccountSection';
import {
  OPENAI_CODEX_AUTH_CHANGED_EVENT,
  openaiCodexAuthClient,
  type OpenAICodexAuthChangedDetail,
} from '../openaiCodexAuthClient';
import { useVendorModels } from '@/hooks/useVendorModels';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
};

const codexVendor: VendorConfig = {
  id: 'builtin-openai-codex',
  name: 'OpenAI Codex',
  providerType: 'openai_codex',
  authMode: 'openai_codex_oauth',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  apiKey: '',
  isBuiltin: true,
  isReadOnly: true,
};

const codexProfile: ModelProfile = {
  id: 'builtin-codex-test',
  vendorId: codexVendor.id,
  label: 'GPT Codex',
  model: 'gpt-5.4',
  modelAdapter: 'openai',
  status: 'enabled',
  enabled: true,
  isMultimodal: true,
  isReasoning: true,
  isEmbedding: false,
  isReranker: false,
  supportsTools: true,
};

const VendorAvailabilityProbe: React.FC = () => {
  const { loading, resolvedApiConfigs } = useVendorModels();
  const enabled = resolvedApiConfigs.find(config => config.id === codexProfile.id)?.enabled;
  return <span data-testid="codex-model-availability">{loading ? 'loading' : enabled ? 'enabled' : 'disabled'}</span>;
};

describe('OpenAICodexAccountSection', () => {
  beforeEach(() => {
    openaiCodexAuthClient.stopStatusMonitor();
    invokeMock.mockReset();
    openUrlMock.mockClear();
  });

  afterEach(() => {
    openaiCodexAuthClient.stopStatusMonitor();
    vi.useRealTimers();
  });

  it('starts browser login, opens the authorization URL, and never renders returned token fields', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'openai_codex_auth_status') {
        return { phase: 'signed_out', accessToken: 'status-secret-token' };
      }
      if (command === 'openai_codex_login_start') {
        expect(args).toEqual({ flow: 'browser' });
        return {
          attemptId: 'login-1',
          authorizationUrl: 'https://auth.openai.com/authorize?state=safe-state',
          redirectUri: 'http://localhost:1455/auth/callback',
          expiresAtUnixMs: 1_900_000_000_000,
          refreshToken: 'login-secret-token',
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { container } = render(<OpenAICodexAccountSection />);

    const signIn = await screen.findByRole('button', { name: 'Sign in with browser' });
    fireEvent.click(signIn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('openai_codex_login_start', { flow: 'browser' });
      expect(openUrlMock).toHaveBeenCalledWith('https://auth.openai.com/authorize?state=safe-state');
    });
    expect(await screen.findByText('Waiting for browser')).toBeInTheDocument();
    expect(container.textContent).not.toContain('status-secret-token');
    expect(container.textContent).not.toContain('login-secret-token');

    for (const call of invokeMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('secret-token');
    }
  });

  it('shows signed-in account usage and logs out without exposing credentials', async () => {
    let signedIn = true;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'openai_codex_auth_status') {
        return signedIn
          ? {
              phase: 'authenticated',
              accountHint: 's***@example.com',
              expiresAtUnixMs: 1_900_000_000_000,
              accessToken: 'signed-in-secret-token',
            }
          : { phase: 'signed_out' };
      }
      if (command === 'openai_codex_usage') {
        return {
          rateLimits: {
            planType: 'pro',
            primary: {
              usedPercent: 35,
              windowDurationMins: 300,
              resetsAt: 1_900_000_000,
            },
          },
          token: 'usage-secret-token',
        };
      }
      if (command === 'openai_codex_logout') {
        signedIn = false;
        return true;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { container } = render(<OpenAICodexAccountSection />);

    expect(await screen.findByText('s***@example.com')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
    });
    expect(container.textContent).not.toContain('signed-in-secret-token');
    expect(container.textContent).not.toContain('usage-secret-token');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('openai_codex_logout', undefined);
      expect(screen.getByText('Signed out')).toBeInTheDocument();
    });
  });

  it('supports device-code login and cancellation', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'openai_codex_auth_status') return { phase: 'signed_out' };
      if (command === 'openai_codex_login_start') {
        expect(args).toEqual({ flow: 'device_code' });
        return {
          attemptId: 'device-login',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH',
          expiresAtUnixMs: 1_900_000_000_000,
          pollIntervalSeconds: 5,
        };
      }
      if (command === 'openai_codex_login_cancel') {
        expect(args).toEqual({ attemptId: 'device-login' });
        return true;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OpenAICodexAccountSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use device code' }));

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(openUrlMock).toHaveBeenCalledWith('https://auth.openai.com/codex/device');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('openai_codex_login_cancel', { attemptId: 'device-login' });
      expect(screen.getByText('Signed out')).toBeInTheDocument();
    });
  });

  it('binds cancellation to the displayed attempt and preserves a newer attempt', async () => {
    const cancelRequest = deferred<void>();
    let currentAttempt = 'attempt-old';
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'openai_codex_auth_status') {
        return {
          phase: 'authorizing',
          activeLoginKind: 'device',
          activeAttemptId: currentAttempt,
          userCode: currentAttempt === 'attempt-old' ? 'OLD-CODE' : 'NEW-CODE',
          pollIntervalSeconds: 30,
        };
      }
      if (command === 'openai_codex_login_cancel') {
        expect(args).toEqual({ attemptId: 'attempt-old' });
        return cancelRequest.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OpenAICodexAccountSection />);
    expect(await screen.findByText('OLD-CODE')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    currentAttempt = 'attempt-new';
    act(() => {
      window.dispatchEvent(new CustomEvent<OpenAICodexAuthChangedDetail>(OPENAI_CODEX_AUTH_CHANGED_EVENT, {
        detail: {
          source: 'openai_codex_auth',
          status: {
            state: 'pending_device_code',
            loginId: 'attempt-new',
            userCode: 'NEW-CODE',
            pollIntervalSeconds: 30,
          },
        },
      }));
    });
    expect(await screen.findByText('NEW-CODE')).toBeInTheDocument();

    await act(async () => {
      cancelRequest.resolve();
      await cancelRequest.promise;
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('openai_codex_login_cancel', { attemptId: 'attempt-old' });
      expect(screen.getByText('NEW-CODE')).toBeInTheDocument();
    });
  });

  it('maps a safe backend error code and redacts the backend message', async () => {
    invokeMock.mockResolvedValue({
      phase: 'authorizing',
      activeLoginKind: 'device',
      activeAttemptId: 'attempt-current',
      expiresAtUnixMs: 1_900_000_000_000,
      lastError: {
        code: 'network_error',
        class: 'transient',
        message: 'Bearer backend-secret-token',
      },
    });

    const { container } = render(<OpenAICodexAccountSection />);

    expect(await screen.findByText('Waiting for code')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach OpenAI. Check your network and try again.');
    expect(container.textContent).not.toContain('backend-secret-token');
    expect(container.textContent).not.toContain('Bearer');
  });

  it('normalizes usable-session state without hiding an active authorization flow', async () => {
    invokeMock.mockResolvedValue({
      phase: 'authorizing',
      activeLoginKind: 'browser',
      activeAttemptId: 'relogin',
      hasUsableSession: true,
    });

    await expect(openaiCodexAuthClient.status()).resolves.toMatchObject({
      state: 'pending_browser',
      loginId: 'relogin',
      hasUsableSession: true,
    });

    invokeMock.mockResolvedValue({
      phase: 'authorizing',
      activeLoginKind: 'browser',
      activeAttemptId: 'required-relogin',
      hasUsableSession: false,
    });
    await expect(openaiCodexAuthClient.status()).resolves.toMatchObject({
      state: 'pending_browser',
      loginId: 'required-relogin',
      hasUsableSession: false,
    });
  });

  it('does not let an older status request overwrite a newer observation', async () => {
    const olderStatus = deferred<Record<string, unknown>>();
    const newerStatus = deferred<Record<string, unknown>>();
    let statusCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== 'openai_codex_auth_status') {
        throw new Error(`Unexpected command: ${command}`);
      }
      statusCalls += 1;
      return statusCalls === 1 ? olderStatus.promise : newerStatus.promise;
    });

    const olderRequest = openaiCodexAuthClient.status();
    const newerRequest = openaiCodexAuthClient.status();
    newerStatus.resolve({ phase: 'authenticated', accountHint: 'newer@example.com', generation: 2 });
    await expect(newerRequest).resolves.toMatchObject({
      state: 'signed_in',
      accountHint: 'newer@example.com',
      generation: 2,
    });

    olderStatus.resolve({ phase: 'signed_out', generation: 1 });
    await expect(olderRequest).resolves.toMatchObject({
      state: 'signed_in',
      accountHint: 'newer@example.com',
      generation: 2,
    });
  });

  it('does not let a stale usage response overwrite usage for a different account', async () => {
    const firstUsage = deferred<Record<string, unknown>>();
    const secondUsage = deferred<Record<string, unknown>>();
    let usageCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'openai_codex_auth_status') {
        return { phase: 'authenticated', accountHint: 'first@example.com' };
      }
      if (command === 'openai_codex_usage') {
        usageCalls += 1;
        return usageCalls === 1 ? firstUsage.promise : secondUsage.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OpenAICodexAccountSection />);
    expect(await screen.findByText('first@example.com')).toBeInTheDocument();
    await waitFor(() => expect(usageCalls).toBe(1));

    act(() => {
      window.dispatchEvent(new CustomEvent<OpenAICodexAuthChangedDetail>(OPENAI_CODEX_AUTH_CHANGED_EVENT, {
        detail: {
          source: 'openai_codex_auth',
          status: { state: 'signed_in', accountHint: 'second@example.com' },
        },
      }));
    });
    expect(await screen.findByText('second@example.com')).toBeInTheDocument();
    await waitFor(() => expect(usageCalls).toBe(2));

    await act(async () => {
      secondUsage.resolve({
        rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } },
      });
      await secondUsage.promise;
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');

    await act(async () => {
      firstUsage.resolve({
        rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300 } },
      });
      await firstUsage.promise;
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
  });

  it('invalidates stale usage when the session generation changes under the same account hint', async () => {
    const firstUsage = deferred<Record<string, unknown>>();
    const secondUsage = deferred<Record<string, unknown>>();
    let usageCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'openai_codex_auth_status') {
        return { phase: 'authenticated', accountHint: '***123456', generation: 1 };
      }
      if (command === 'openai_codex_usage') {
        usageCalls += 1;
        return usageCalls === 1 ? firstUsage.promise : secondUsage.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OpenAICodexAccountSection />);
    expect(await screen.findByText('***123456')).toBeInTheDocument();
    await waitFor(() => expect(usageCalls).toBe(1));

    act(() => {
      window.dispatchEvent(new CustomEvent<OpenAICodexAuthChangedDetail>(OPENAI_CODEX_AUTH_CHANGED_EVENT, {
        detail: {
          source: 'openai_codex_auth',
          status: { state: 'signed_in', accountHint: '***123456', generation: 2 },
        },
      }));
    });
    await waitFor(() => expect(usageCalls).toBe(2));

    await act(async () => {
      secondUsage.resolve({
        rateLimits: { primary: { usedPercent: 15, windowDurationMins: 300 } },
      });
      await secondUsage.promise;
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '15');

    await act(async () => {
      firstUsage.resolve({
        rateLimits: { primary: { usedPercent: 88, windowDurationMins: 300 } },
      });
      await firstUsage.promise;
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '15');
  });

  it('keeps monitoring after the account section unmounts and reloads OAuth models', async () => {
    let phase: 'signed_out' | 'authorizing' | 'authenticated' = 'signed_out';
    let vendorLoads = 0;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_vendor_configs') {
        vendorLoads += 1;
        return [codexVendor];
      }
      if (command === 'get_model_profiles') return [codexProfile];
      if (command === 'get_model_assignments') return {};
      if (command === 'openai_codex_auth_status') {
        return phase === 'authenticated'
          ? { phase, accountHint: 'authenticated@example.com' }
          : { phase, activeLoginKind: 'browser', activeAttemptId: phase === 'authorizing' ? 'login-monitor' : undefined };
      }
      if (command === 'openai_codex_login_start') {
        expect(args).toEqual({ flow: 'browser' });
        phase = 'authorizing';
        return {
          attemptId: 'login-monitor',
          authorizationUrl: 'https://auth.openai.com/authorize?state=monitor',
          pollIntervalSeconds: 1,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const Harness: React.FC<{ showAccount: boolean }> = ({ showAccount }) => (
      <>
        {showAccount && <OpenAICodexAccountSection key="account" />}
        <VendorAvailabilityProbe key="availability" />
      </>
    );
    const authEvents: OpenAICodexAuthChangedDetail[] = [];
    const handleAuthChanged = (event: Event) => {
      authEvents.push((event as CustomEvent<OpenAICodexAuthChangedDetail>).detail);
    };
    window.addEventListener(OPENAI_CODEX_AUTH_CHANGED_EVENT, handleAuthChanged);

    try {
      const view = render(<Harness showAccount />);
      const signIn = await screen.findByRole('button', { name: 'Sign in with browser' });
      await waitFor(() => {
        expect(screen.getByTestId('codex-model-availability')).toHaveTextContent('disabled');
      });

      vi.useFakeTimers();
      fireEvent.click(signIn);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(openUrlMock).toHaveBeenCalledWith('https://auth.openai.com/authorize?state=monitor');

      view.rerender(<Harness showAccount={false} />);
      const vendorLoadsBeforeAuthentication = vendorLoads;
      phase = 'authenticated';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(authEvents.some(detail => detail.status.state === 'signed_in')).toBe(true);
      expect(vendorLoads).toBe(vendorLoadsBeforeAuthentication + 1);
      expect(screen.getByTestId('codex-model-availability')).toHaveTextContent('enabled');
    } finally {
      window.removeEventListener(OPENAI_CODEX_AUTH_CHANGED_EVENT, handleAuthChanged);
    }
  });

  it('applies an auth broadcast even when the following vendor reload fails', async () => {
    let vendorLoads = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_vendor_configs') {
        vendorLoads += 1;
        if (vendorLoads === 1) return [codexVendor];
        throw new Error('config reload failed');
      }
      if (command === 'get_model_profiles') return [codexProfile];
      if (command === 'get_model_assignments') return {};
      if (command === 'openai_codex_auth_status') {
        return { phase: 'authenticated', accountHint: 'authenticated@example.com' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    try {
      render(<VendorAvailabilityProbe />);
      await waitFor(() => {
        expect(screen.getByTestId('codex-model-availability')).toHaveTextContent('enabled');
      });

      act(() => {
        window.dispatchEvent(new CustomEvent<OpenAICodexAuthChangedDetail>(OPENAI_CODEX_AUTH_CHANGED_EVENT, {
          detail: {
            source: 'openai_codex_auth',
            status: { state: 'signed_out' },
          },
        }));
      });

      await waitFor(() => {
        expect(vendorLoads).toBe(2);
        expect(screen.getByTestId('codex-model-availability')).toHaveTextContent('disabled');
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
