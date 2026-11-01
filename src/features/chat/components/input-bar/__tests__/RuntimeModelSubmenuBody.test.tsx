/**
 * 紧凑模型子菜单：收藏分区/排序、星标切换与持久化、搜索、多选模式（勾选/取消/chips）。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && 'count' in options) return `${key}:${String(options.count)}`;
      if (options && 'model' in options) return `${key}:${String(options.model)}`;
      return key;
    },
  }),
}));

import { RuntimeModelSubmenuBody, type RuntimeModelOption } from '../RuntimeModelSubmenuBody';
import { __resetFavoriteChatModelsForTests } from '../../../hooks/useFavoriteChatModels';

type Profile = { id: string; isFavorite?: boolean };
let profiles: Profile[];

const OPTIONS: RuntimeModelOption[] = [
  { id: 'ds-v3', label: 'deepseek-v3', providerLabel: 'DeepSeek', providerId: 'deepseek' },
  { id: 'ds-r1', label: 'deepseek-r1', providerLabel: 'DeepSeek', providerId: 'deepseek', isRecent: true, recentRank: 1 },
  { id: 'gpt-4o', label: 'gpt-4o', providerLabel: 'OpenAI', providerId: 'openai', isRecent: true, recentRank: 2 },
  { id: 'gpt-5', label: 'gpt-5', providerLabel: 'OpenAI', providerId: 'openai', isRecent: true, recentRank: 0 },
];

function sectionOf(key: string): HTMLElement {
  const section = document.querySelector<HTMLElement>(`[data-section="${key}"]`);
  if (!section) throw new Error(`section ${key} not rendered`);
  return section;
}

function rowIds(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll<HTMLElement>('[data-model-id]')).map((el) => el.dataset.modelId ?? '');
}

beforeEach(() => {
  __resetFavoriteChatModelsForTests();
  profiles = [
    { id: 'ds-v3' },
    { id: 'ds-r1' },
    { id: 'gpt-4o', isFavorite: true },
    { id: 'gpt-5' },
    // 已删除/失效模型的收藏：不在可用模型中，应被静默忽略
    { id: 'removed-model', isFavorite: true },
  ];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: { profiles?: Profile[] }) => {
    if (cmd === 'get_model_profiles') return profiles.map((p) => ({ ...p }));
    if (cmd === 'save_model_profiles') {
      profiles = (args?.profiles ?? []).map((p) => ({ ...p }));
    }
    return undefined;
  });
});

afterEach(() => {
  __resetFavoriteChatModelsForTests();
});

describe('RuntimeModelSubmenuBody', () => {
  it('orders sections as favorites → recent (without favorites, by recency) → providers', async () => {
    render(<RuntimeModelSubmenuBody options={OPTIONS} currentModelId="ds-v3" onSelect={vi.fn()} />);

    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['gpt-4o']));
    const sectionKeys = Array.from(document.querySelectorAll<HTMLElement>('[data-section]')).map((el) => el.dataset.section);
    expect(sectionKeys).toEqual(['__favorites__', '__recent__', 'provider:deepseek', 'provider:openai']);
    // 最近：按 recentRank 排序且剔除已收藏的 gpt-4o
    expect(rowIds(sectionOf('__recent__'))).toEqual(['gpt-5', 'ds-r1']);
    // 收藏模型在供应商分组中仍可见，星标为已收藏态
    const openai = sectionOf('provider:openai');
    expect(rowIds(openai)).toEqual(['gpt-4o', 'gpt-5']);
    const stars = within(openai).getAllByTestId('runtime-model-favorite-toggle');
    expect(stars[0]).toHaveAttribute('aria-pressed', 'true');
    expect(stars[1]).toHaveAttribute('aria-pressed', 'false');
    // 失效模型的收藏不渲染
    expect(document.querySelector('[data-model-id="removed-model"]')).toBeNull();
  });

  it('toggles a favorite from the star without selecting the model, and persists it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<RuntimeModelSubmenuBody options={OPTIONS} currentModelId="ds-v3" onSelect={onSelect} />);
    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['gpt-4o']));

    const deepseek = sectionOf('provider:deepseek');
    await user.click(within(deepseek).getAllByTestId('runtime-model-favorite-toggle')[0]);

    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['ds-v3', 'gpt-4o']));
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(profiles.find((p) => p.id === 'ds-v3')?.isFavorite).toBe(true));

    // 取消收藏
    await user.click(within(sectionOf('__favorites__')).getAllByTestId('runtime-model-favorite-toggle')[1]);
    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['ds-v3']));
    await waitFor(() => expect(profiles.find((p) => p.id === 'gpt-4o')?.isFavorite).toBe(false));
  });

  it('toggles favorite with the F key on a focused row', async () => {
    render(<RuntimeModelSubmenuBody options={OPTIONS} currentModelId="ds-v3" onSelect={vi.fn()} />);
    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['gpt-4o']));
    const row = sectionOf('provider:deepseek').querySelector<HTMLElement>('[data-model-id="ds-r1"]')!;
    act(() => {
      row.focus();
      fireEvent.keyDown(row, { key: 'f' });
    });
    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['ds-r1', 'gpt-4o']));
  });

  it('keeps the favorites section while searching and hides recent', async () => {
    const user = userEvent.setup();
    render(<RuntimeModelSubmenuBody options={OPTIONS} currentModelId="ds-v3" onSelect={vi.fn()} />);
    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['gpt-4o']));

    await user.type(screen.getByPlaceholderText('chatV2:modelPicker.searchPlaceholder'), 'gpt');

    expect(rowIds(sectionOf('__favorites__'))).toEqual(['gpt-4o']);
    expect(document.querySelector('[data-section="__recent__"]')).toBeNull();
    expect(rowIds(sectionOf('provider:openai'))).toEqual(['gpt-4o', 'gpt-5']);
    expect(document.querySelector('[data-section="provider:deepseek"]')).toBeNull();
  });

  it('selects a single model in single mode', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<RuntimeModelSubmenuBody options={OPTIONS} currentModelId="ds-v3" onSelect={onSelect} />);
    await user.click(within(sectionOf('provider:openai')).getByRole('menuitem', { name: /gpt-5/ }));
    expect(onSelect).toHaveBeenCalledWith('gpt-5');
    // 未提供多选配置时不显示开关
    expect(screen.queryByTestId('runtime-model-multi-select-switch')).toBeNull();
  });

  it('switches to multi-select inside the same picker and syncs check state with the selection', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    function Harness() {
      const [active, setActive] = React.useState(false);
      const [selected, setSelected] = React.useState<string[]>([]);
      return (
        <RuntimeModelSubmenuBody
          options={OPTIONS}
          currentModelId="ds-v3"
          onSelect={onSelect}
          multiSelect={{
            active: active || selected.length > 0,
            selectedIds: selected,
            onActiveChange: (next) => {
              setActive(next);
              if (!next) setSelected([]);
            },
            onToggle: (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
          }}
        />
      );
    }

    render(<Harness />);
    const toggle = screen.getByTestId('runtime-model-multi-select-switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryAllByRole('menuitemcheckbox', { name: /deepseek-v3/ })).toHaveLength(0);

    await user.click(toggle);
    expect(screen.getByTestId('runtime-model-multi-select-switch')).toHaveAttribute('aria-checked', 'true');

    const deepseek = sectionOf('provider:deepseek');
    await user.click(within(deepseek).getByRole('menuitemcheckbox', { name: /deepseek-v3/ }));
    await user.click(within(sectionOf('provider:openai')).getByRole('menuitemcheckbox', { name: /gpt-5/ }));
    expect(onSelect).not.toHaveBeenCalled();

    expect(within(sectionOf('provider:deepseek')).getByRole('menuitemcheckbox', { name: /deepseek-v3/ })).toHaveAttribute('aria-checked', 'true');
    const chips = screen.getByTestId('runtime-model-selected-chips');
    expect(within(chips).getByText('deepseek-v3')).toBeInTheDocument();
    expect(within(chips).getByText('gpt-5')).toBeInTheDocument();
    expect(screen.getByText('chatV2:modelPicker.multiSelectCount:2')).toBeInTheDocument();

    // 同一模型在「最近」分区里的勾选状态同步
    expect(within(sectionOf('__recent__')).getByRole('menuitemcheckbox', { name: /gpt-5/ })).toHaveAttribute('aria-checked', 'true');

    // chip 上的移除 = 取消勾选
    await user.click(within(chips).getByRole('button', { name: 'chatV2:modelPicker.removeSelected:gpt-5' }));
    expect(within(sectionOf('provider:openai')).getByRole('menuitemcheckbox', { name: /gpt-5/ })).toHaveAttribute('aria-checked', 'false');

    // 再次点击行取消勾选
    await user.click(within(sectionOf('provider:deepseek')).getByRole('menuitemcheckbox', { name: /deepseek-v3/ }));
    expect(screen.queryByTestId('runtime-model-selected-chips')).toBeNull();
    expect(screen.getByText('chatV2:modelPicker.multiSelectEmpty')).toBeInTheDocument();

    // 关闭多选：回到单选行
    await user.click(screen.getByTestId('runtime-model-multi-select-switch'));
    expect(screen.queryAllByRole('menuitemcheckbox', { name: /deepseek-v3/ })).toHaveLength(0);
  });

  it('keeps favorites usable in multi-select mode', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <RuntimeModelSubmenuBody
        options={OPTIONS}
        currentModelId="ds-v3"
        onSelect={vi.fn()}
        multiSelect={{ active: true, selectedIds: [], onActiveChange: vi.fn(), onToggle }}
      />
    );
    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['gpt-4o']));
    await user.click(within(sectionOf('provider:deepseek')).getAllByTestId('runtime-model-favorite-toggle')[1]);
    await waitFor(() => expect(rowIds(sectionOf('__favorites__'))).toEqual(['ds-r1', 'gpt-4o']));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
