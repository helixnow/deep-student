import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { AdvancedPanel } from '../AdvancedPanel';
import { clearModelsCache } from '../../../hooks/useAvailableModels';
import type { ChatStore } from '../../../core/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({ isMobile: false }),
}));

let defaultModelId: string;
let models: Array<Record<string, unknown>>;

function renderPanel(params: Record<string, unknown> = {}) {
  const store = createStore<ChatStore>()((set) => ({
    sessionStatus: 'idle',
    chatParams: {
      modelId: '',
      modelIdPinnedByUser: false,
      model2OverrideId: null,
      maxTokens: 128_000,
      ...params,
    },
    setChatParams: (patch: Record<string, unknown>) => set((state) => ({
      chatParams: { ...state.chatParams, ...patch },
    })),
  } as unknown as ChatStore));
  render(<AdvancedPanel store={store} onClose={vi.fn()} sidebarMode />);
  return store;
}

function contextInput() {
  return screen.getByLabelText('chat_host:advanced.context.label');
}

describe('AdvancedPanel model context window', () => {
  beforeEach(() => {
    clearModelsCache();
    defaultModelId = 'configured-deepseek';
    models = [
      { id: defaultModelId, model: 'tree-deepseek-v4.1-flash', name: 'DeepSeek', enabled: true, contextWindow: 1_000_448 },
      { id: 'small-model', model: 'small-model', name: 'Small', enabled: true, contextWindow: 64_000 },
    ];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'get_api_configurations') return models;
      if (command === 'get_model_assignments') return { model2_config_id: defaultModelId };
      return undefined;
    });
  });

  afterEach(() => {
    cleanup();
    clearModelsCache();
    vi.clearAllMocks();
  });

  it('uses the configured global default window in an unpinned session and accepts its exact endpoint', async () => {
    const store = renderPanel();
    await waitFor(() => expect(contextInput()).toHaveAttribute('aria-valuemax', '1000448'));
    fireEvent.change(contextInput(), { target: { value: '1000448' } });
    fireEvent.blur(contextInput());
    expect(store.getState().chatParams.contextLimit).toBe(1_000_448);
  });

  it('uses a runtime override before the default and keeps explicitly pinned sessions pinned', async () => {
    const store = renderPanel({ modelId: 'small-model', modelIdPinnedByUser: true });
    await waitFor(() => expect(contextInput()).toHaveAttribute('aria-valuemax', '64000'));
    act(() => store.getState().setChatParams({ model2OverrideId: 'configured-deepseek' }));
    await waitFor(() => expect(contextInput()).toHaveAttribute('aria-valuemax', '1000448'));
  });

  it('updates the upper bound when the default assignment changes while the panel is open', async () => {
    renderPanel();
    await waitFor(() => expect(contextInput()).toHaveAttribute('aria-valuemax', '1000448'));
    defaultModelId = 'small-model';
    act(() => window.dispatchEvent(new Event('model_assignments_changed')));
    await waitFor(() => expect(contextInput()).toHaveAttribute('aria-valuemax', '64000'));
  });

  it('refreshes configured window edits without waiting for the model cache TTL', async () => {
    renderPanel();
    await waitFor(() => expect(contextInput()).toHaveAttribute('aria-valuemax', '1000448'));
    models = models.map((model) => model.id === defaultModelId ? { ...model, contextWindow: 1_500_000 } : model);
    act(() => window.dispatchEvent(new Event('api_configurations_changed')));
    await waitFor(() => expect(contextInput()).toHaveAttribute('aria-valuemax', '1500000'));
  });
});
