import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { SiliconFlowSection } from '../SiliconFlowSection';
import { VendorApiKeySection } from '../VendorApiKeySection';
import { TauriAPI } from '../../../utils/tauriApi';

const installLocalStorageMock = () => {
  let store: Record<string, string> = {};
  const storage = {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
};

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

vi.mock('../../UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../../../utils/tauriApi', () => ({
  TauriAPI: {
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
    deleteSetting: vi.fn(),
  },
}));

describe('API key clearing confirmation', () => {
  beforeEach(() => {
    installLocalStorageMock();
    vi.clearAllMocks();
    localStorage.clear();
    (TauriAPI.getSetting as any).mockResolvedValue(null);
    (TauriAPI.saveSetting as any).mockResolvedValue(undefined);
    (TauriAPI.deleteSetting as any).mockResolvedValue(undefined);
  });

  test('requires a second click before clearing the SiliconFlow key and removes legacy localStorage', async () => {
    localStorage.setItem('siliconflow_api_key', 'legacy-key');

    render(<SiliconFlowSection variant="inline" onCreateConfig={vi.fn()} />);

    const input = await screen.findByDisplayValue('legacy-key');
    expect(input).toBeInTheDocument();

    const clearButton = screen.getByRole('button', { name: /common:siliconflow.clear_button/ });
    fireEvent.click(clearButton);

    expect(TauriAPI.deleteSetting).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /common:siliconflow.clear_confirm_button/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /common:siliconflow.clear_confirm_button/ }));

    await waitFor(() => {
      expect(TauriAPI.deleteSetting).toHaveBeenCalledWith('builtin-siliconflow.api_key');
      expect(TauriAPI.deleteSetting).toHaveBeenCalledWith('siliconflow.api_key');
    });
    expect(localStorage.getItem('siliconflow_api_key')).toBeNull();
  });

  test('requires a second click before clearing a generic vendor API key', () => {
    const onClear = vi.fn();

    render(
      <VendorApiKeySection
        vendor={{
          id: 'vendor-1',
          name: 'Vendor',
          providerType: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKey: 'sk-test',
          headers: {},
        }}
        onSave={vi.fn()}
        onClear={onClear}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /settings:vendor_panel.clear_api_key/ }));

    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /settings:vendor_panel.clear_api_key_confirm/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /settings:vendor_panel.clear_api_key_confirm/ }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
