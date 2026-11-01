/**
 * ModelPicker（重试/命令面板等入口复用的面板）同样支持星标收藏与「收藏」分区。
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async () => null),
  saveSetting: vi.fn(async () => undefined),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

import { ModelPicker } from '../ModelPicker';
import { __resetFavoriteChatModelsForTests } from '../../../hooks/useFavoriteChatModels';

const base = { enabled: true, isEmbedding: false, isReranker: false, supportsTools: true };
const CONFIGS = [
  { ...base, id: 'ds', name: 'DeepSeek', model: 'deepseek-chat', vendorId: 'v-ds' },
  { ...base, id: 'gpt', name: 'GPT', model: 'gpt-4o', vendorId: 'v-oa' },
];
let profiles: Array<{ id: string; isFavorite?: boolean }>;

beforeEach(() => {
  __resetFavoriteChatModelsForTests();
  profiles = [{ id: 'ds' }, { id: 'gpt', isFavorite: true }, { id: 'gone', isFavorite: true }];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: { profiles?: typeof profiles }) => {
    if (cmd === 'get_api_configurations') return CONFIGS;
    if (cmd === 'get_vendor_configs') {
      return [
        { id: 'v-ds', name: 'DeepSeek' },
        { id: 'v-oa', name: 'OpenAI' },
      ];
    }
    if (cmd === 'get_model_assignments') return {};
    if (cmd === 'get_model_profiles') return profiles.map((p) => ({ ...p }));
    if (cmd === 'save_model_profiles') profiles = (args?.profiles ?? []).map((p) => ({ ...p }));
    return undefined;
  });
});

afterEach(() => {
  __resetFavoriteChatModelsForTests();
});

function favoritesSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-section="favorites"]');
}

describe('ModelPicker favorites', () => {
  it('lists favorites first and toggles them without selecting the row', async () => {
    const user = userEvent.setup();
    const onSelectSingle = vi.fn();
    render(<ModelPicker mode="single" onClose={() => {}} onSelectSingle={onSelectSingle} />);

    await waitFor(() => expect(favoritesSection()).not.toBeNull());
    expect(within(favoritesSection()!).getByText('gpt-4o')).toBeInTheDocument();
    expect(within(favoritesSection()!).queryByText('deepseek-chat')).toBeNull();

    const dsRow = screen.getAllByText('deepseek-chat')[0].closest('button')!;
    await user.click(within(dsRow).getByTestId('model-picker-favorite-toggle'));

    await waitFor(() => expect(within(favoritesSection()!).getByText('deepseek-chat')).toBeInTheDocument());
    expect(onSelectSingle).not.toHaveBeenCalled();
    await waitFor(() => expect(profiles.find((p) => p.id === 'ds')?.isFavorite).toBe(true));
  });
});
