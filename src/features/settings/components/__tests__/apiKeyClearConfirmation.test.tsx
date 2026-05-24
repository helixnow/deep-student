import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SiliconFlowSection } from '../SiliconFlowSection';
import { VendorApiKeySection } from '../VendorApiKeySection';
import { TauriAPI } from '@/utils/tauriApi';

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

vi.mock('@/utils/tauriApi', () => ({
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
    vi.useRealTimers();
    localStorage.clear();
    (TauriAPI.getSetting as any).mockResolvedValue(null);
    (TauriAPI.saveSetting as any).mockResolvedValue(undefined);
    (TauriAPI.deleteSetting as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  test('does not show a reveal toggle for a masked generic vendor API key', () => {
    render(
      <VendorApiKeySection
        vendor={{
          id: 'vendor-1',
          name: 'Vendor',
          providerType: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKey: '***',
          headers: {},
        }}
        onSave={vi.fn()}
        onClear={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/settings:vendor_panel.api_key_configured/);
    expect(input).toBeInTheDocument();
    expect(input).not.toHaveClass('pr-12');
    expect(screen.queryByRole('button', { name: /settings:vendor_panel.show_api_key/ })).not.toBeInTheDocument();
  });

  test('keeps the generic vendor reveal toggle inside the input shell without absolute overlay', () => {
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
        onClear={vi.fn()}
      />
    );

    const input = screen.getByDisplayValue('sk-test');
    const revealButton = screen.getByRole('button', { name: /settings:vendor_panel.show_api_key/ });

    expect(input).toHaveClass('api-key-field__input');
    expect(input).not.toHaveClass('pr-12');
    expect(revealButton).toHaveAttribute('aria-pressed', 'false');
    expect(revealButton).not.toHaveClass('absolute', 'inset-y-0', 'right-0');
    expect(revealButton).toHaveClass('api-key-field__toggle');
    expect(revealButton.className).not.toContain('rounded-[var(--button-radius)]');
  });

  test('keeps the SiliconFlow reveal toggle inside the input shell without absolute overlay', async () => {
    (TauriAPI.getSetting as any).mockImplementation((key: string) => {
      if (key === 'builtin-siliconflow.api_key') return Promise.resolve('sf-key');
      return Promise.resolve(null);
    });

    render(<SiliconFlowSection variant="inline" onCreateConfig={vi.fn()} />);

    const input = await screen.findByDisplayValue('sf-key');
    const revealButton = screen.getByRole('button', { name: /common:siliconflow.show_api_key/ });

    expect(input).toHaveClass('api-key-field__input');
    expect(input).not.toHaveClass('pr-12');
    expect(revealButton).toHaveAttribute('aria-pressed', 'false');
    expect(revealButton).not.toHaveClass('absolute', 'inset-y-0', 'right-0');
    expect(revealButton).toHaveClass('api-key-field__toggle');
    expect(revealButton.className).not.toContain('rounded-[var(--button-radius)]');
  });

  test('does not save a vendor API key until the user clicks save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const showMessage = vi.fn();

    render(
      <VendorApiKeySection
        vendor={{
          id: 'vendor-1',
          name: 'Vendor',
          providerType: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKey: '',
          headers: {},
        }}
        onSave={onSave}
        onClear={vi.fn()}
        showMessage={showMessage}
      />
    );

    const input = screen.getByPlaceholderText(/settings:vendor_panel.api_key_placeholder/);
    fireEvent.change(input, { target: { value: 'sk-pasted-value' } });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved|未保存/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save|保存/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('sk-pasted-value');
    });
    expect(showMessage).toHaveBeenCalledWith('success', expect.stringMatching(/saved|已保存/i));
  });
});
