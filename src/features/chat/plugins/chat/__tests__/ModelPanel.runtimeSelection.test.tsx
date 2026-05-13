import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore } from 'zustand/vanilla';
import { ModelPanel } from '../ModelPanel';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown> | string) => {
      if (typeof options === 'string') return options;
      if (typeof options?.model === 'string') return options.model;
      return _key;
    },
  }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({ isMobile: false }),
}));

function createModelPanelStore() {
  return createStore<any>((set) => ({
    chatParams: {
      modelId: 'cfg-base',
      modelDisplayName: 'provider/base-model',
      model2OverrideId: null,
    },
    setChatParams: (params: Record<string, unknown>) =>
      set((state: any) => ({
        chatParams: {
          ...state.chatParams,
          ...params,
        },
      })),
  }));
}

describe('ModelPanel runtime selection', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_api_configurations') {
        return [
          {
            id: 'cfg-base',
            name: 'Base Model',
            model: 'provider/base-model',
            vendorId: 'vendor-a',
            enabled: true,
          },
          {
            id: 'cfg-qwen',
            name: 'Qwen Max',
            model: 'qwen-max-latest',
            vendorId: 'vendor-a',
            enabled: true,
          },
        ];
      }
      if (command === 'get_vendor_configs') {
        return [{ id: 'vendor-a', name: 'Vendor A', providerType: 'openai', sortOrder: 0 }];
      }
      if (command === 'get_model_assignments') {
        return { model2_config_id: 'cfg-base' };
      }
      return undefined;
    });
  });

  it('updates the current dialog model display immediately when a model is selected', async () => {
    const user = userEvent.setup();
    const store = createModelPanelStore();

    render(<ModelPanel store={store as any} onClose={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Qwen Max/ }));

    await waitFor(() => {
      expect(store.getState().chatParams).toMatchObject({
        model2OverrideId: 'cfg-qwen',
        modelDisplayName: 'qwen-max-latest',
      });
    });
  });

  it('closes the runtime picker after selecting a model when requested', async () => {
    const user = userEvent.setup();
    const store = createModelPanelStore();
    const onClose = vi.fn();

    render(<ModelPanel store={store as any} onClose={onClose} closeOnSelect />);

    await user.click(await screen.findByRole('button', { name: /Qwen Max/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
