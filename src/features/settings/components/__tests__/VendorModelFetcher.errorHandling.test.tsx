import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchModelsFromVendorMock,
  showGlobalNotificationMock,
  debugWarnMock,
} = vi.hoisted(() => ({
  fetchModelsFromVendorMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
  debugWarnMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'settings:vendor_model_fetcher.fetch_failed') {
        return `Failed to fetch model list: ${String(options?.error ?? '')}`;
      }
      if (key === 'settings:vendor_model_fetcher.fetch_button') return 'Fetch Model List';
      if (key === 'common:error.unknown_error') return 'Unknown error';
      return key;
    },
  }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    log: vi.fn(),
    debug: vi.fn(),
    warn: debugWarnMock,
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async () => undefined),
  },
}));

vi.mock('../vendorModelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vendorModelService')>();
  return {
    ...actual,
    fetchModelsFromVendor: fetchModelsFromVendorMock,
  };
});

import type { VendorConfig } from '@/types';
import { VendorModelFetcher } from '../VendorModelFetcher';

const unreachableVendor: VendorConfig = {
  id: 'vendor-unreachable',
  name: 'Local Dead Endpoint',
  providerType: 'custom',
  authMode: 'none',
  baseUrl: 'http://127.0.0.1:19999/v1',
  apiKey: '',
  headers: {},
};

describe('VendorModelFetcher unreachable provider error handling (G22)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchModelsFromVendorMock.mockReset();
    showGlobalNotificationMock.mockReset();
    debugWarnMock.mockReset();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('surfaces real IPC network error detail in toast and inline alert with zero console.error', async () => {
    const user = userEvent.setup();
    fetchModelsFromVendorMock.mockRejectedValueOnce({
      error_type: 'Network',
      message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:19999',
      details: null,
    });

    render(
      <VendorModelFetcher
        vendor={unreachableVendor}
        existingModelIds={[]}
        onAddModels={vi.fn(async () => undefined)}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Fetch Model List' }));

    await waitFor(() => {
      expect(showGlobalNotificationMock).toHaveBeenCalledTimes(1);
    });

    const [severity, message] = showGlobalNotificationMock.mock.calls[0] as [string, string];
    expect(severity).toBe('error');
    expect(message).toBe('Failed to fetch model list: fetch failed: connect ECONNREFUSED 127.0.0.1:19999');
    expect(message).not.toContain('Unknown error');
    expect(message).not.toMatch(/[\u4e00-\u9fff]/);

    const inlineAlert = screen.getByTestId('vendor-model-fetcher-error');
    expect(inlineAlert).toHaveAttribute('role', 'alert');
    expect(inlineAlert).toHaveTextContent('connect ECONNREFUSED 127.0.0.1:19999');

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(debugWarnMock).toHaveBeenCalledTimes(1);
  });
});
