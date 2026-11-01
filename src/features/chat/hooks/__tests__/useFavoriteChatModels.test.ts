/**
 * 模型收藏：复用 ModelProfile.isFavorite，经 get_model_profiles / save_model_profiles 持久化。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  __resetFavoriteChatModelsForTests,
  useFavoriteChatModels,
} from '../useFavoriteChatModels';

type Profile = { id: string; label: string; isFavorite?: boolean; vendorId: string };

let profiles: Profile[];

beforeEach(() => {
  __resetFavoriteChatModelsForTests();
  profiles = [
    { id: 'a', label: 'A', vendorId: 'v1', isFavorite: true },
    { id: 'b', label: 'B', vendorId: 'v1', isFavorite: false },
    { id: 'c', label: 'C', vendorId: 'v2' },
  ];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: { profiles?: Profile[] }) => {
    if (cmd === 'get_model_profiles') return profiles.map((p) => ({ ...p }));
    if (cmd === 'save_model_profiles') {
      profiles = (args?.profiles ?? []).map((p) => ({ ...p }));
      return undefined;
    }
    return undefined;
  });
});

afterEach(() => {
  __resetFavoriteChatModelsForTests();
});

describe('useFavoriteChatModels', () => {
  it('loads favorites from model profiles', async () => {
    const { result } = renderHook(() => useFavoriteChatModels());
    await waitFor(() => expect(result.current.isFavorite('a')).toBe(true));
    expect(result.current.isFavorite('b')).toBe(false);
    expect(result.current.isFavorite('c')).toBe(false);
  });

  it('toggles a favorite, persists only that profile flag and broadcasts the change', async () => {
    const listener = vi.fn();
    window.addEventListener('api_configurations_changed', listener);
    const { result } = renderHook(() => useFavoriteChatModels());
    await waitFor(() => expect(result.current.isFavorite('a')).toBe(true));

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.toggleFavorite('b');
    });

    expect(outcome).toBe('saved');
    expect(result.current.isFavorite('b')).toBe(true);
    const saveCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'save_model_profiles');
    expect(saveCall).toBeTruthy();
    const saved = (saveCall![1] as { profiles: Profile[] }).profiles;
    expect(saved).toHaveLength(3);
    expect(saved.find((p) => p.id === 'b')?.isFavorite).toBe(true);
    // 其他 profile 原样保留
    expect(saved.find((p) => p.id === 'a')).toEqual({ id: 'a', label: 'A', vendorId: 'v1', isFavorite: true });
    expect(saved.find((p) => p.id === 'c')).toEqual({ id: 'c', label: 'C', vendorId: 'v2' });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('api_configurations_changed', listener);

    // 再次切换 → 取消收藏
    await act(async () => {
      await result.current.toggleFavorite('a');
    });
    expect(result.current.isFavorite('a')).toBe(false);
    expect(profiles.find((p) => p.id === 'a')?.isFavorite).toBe(false);
  });

  it('shows the new state optimistically before the save resolves', async () => {
    let releaseSave: () => void = () => {};
    const { result } = renderHook(() => useFavoriteChatModels());
    await waitFor(() => expect(result.current.isFavorite('a')).toBe(true));
    invokeMock.mockImplementation(async (cmd: string, args?: { profiles?: Profile[] }) => {
      if (cmd === 'get_model_profiles') return profiles.map((p) => ({ ...p }));
      if (cmd === 'save_model_profiles') {
        await new Promise<void>((resolve) => { releaseSave = resolve; });
        profiles = (args?.profiles ?? []).map((p) => ({ ...p }));
      }
      return undefined;
    });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.toggleFavorite('c');
    });
    expect(result.current.isFavorite('c')).toBe(true);
    await waitFor(() => expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'save_model_profiles')).toBe(true));
    await act(async () => {
      releaseSave();
      await pending;
    });
    expect(result.current.isFavorite('c')).toBe(true);
  });

  it('silently ignores favorites for deleted / unknown models', async () => {
    const { result } = renderHook(() => useFavoriteChatModels());
    await waitFor(() => expect(result.current.isFavorite('a')).toBe(true));

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.toggleFavorite('deleted-model');
    });

    expect(outcome).toBe('missing');
    expect(result.current.isFavorite('deleted-model')).toBe(false);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'save_model_profiles')).toBe(false);
  });

  it('rolls back the optimistic state when saving fails', async () => {
    const { result } = renderHook(() => useFavoriteChatModels());
    await waitFor(() => expect(result.current.isFavorite('a')).toBe(true));
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_model_profiles') return profiles.map((p) => ({ ...p }));
      if (cmd === 'save_model_profiles') throw new Error('disk full');
      return undefined;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.toggleFavorite('b');
    });

    expect(outcome).toBe('failed');
    expect(result.current.isFavorite('b')).toBe(false);
    warn.mockRestore();
  });
});
