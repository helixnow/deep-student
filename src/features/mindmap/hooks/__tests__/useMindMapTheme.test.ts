/**
 * useMindMapTheme — 主题解析（暗色模式切换 / 注册变更响应）
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StyleRegistry } from '../../registry/StyleRegistry';
import type { IStyleTheme } from '../../registry/types';
import { useMindMapTheme } from '../useMindMapTheme';

const lightTheme = { id: 'unit-theme', name: '测试主题' } as IStyleTheme;
const darkVariant = { id: 'unit-theme-dark', name: '测试主题（暗）', hidden: true } as IStyleTheme;
const fallbackTheme = { id: 'default', name: '默认' } as IStyleTheme;

describe('useMindMapTheme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    StyleRegistry.register(fallbackTheme);
    StyleRegistry.register(lightTheme);
    StyleRegistry.register(darkVariant);
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    StyleRegistry.unregister(fallbackTheme.id);
    StyleRegistry.unregister(lightTheme.id);
    StyleRegistry.unregister(darkVariant.id);
  });

  it('按 styleId 解析主题，未注册时回退默认', () => {
    const { result, rerender } = renderHook(
      ({ id }) => useMindMapTheme(id),
      { initialProps: { id: 'unit-theme' } },
    );
    expect(result.current).toBe(lightTheme);

    rerender({ id: 'missing-theme' });
    expect(result.current).toBe(fallbackTheme);
  });

  it('html.dark 切换时自动重解析为暗色变体（MutationObserver 异步通知）', async () => {
    const { result } = renderHook(() => useMindMapTheme('unit-theme'));
    expect(result.current).toBe(lightTheme);

    act(() => {
      document.documentElement.classList.add('dark');
    });
    await waitFor(() => {
      expect(result.current).toBe(darkVariant);
    });

    act(() => {
      document.documentElement.classList.remove('dark');
    });
    await waitFor(() => {
      expect(result.current).toBe(lightTheme);
    });
  });

  it('主题注册变更时收到通知并重解析', () => {
    const { result } = renderHook(() => useMindMapTheme('late-theme'));
    expect(result.current).toBe(fallbackTheme);

    const lateTheme = { id: 'late-theme', name: '后注册' } as IStyleTheme;
    act(() => {
      StyleRegistry.register(lateTheme);
    });
    expect(result.current).toBe(lateTheme);

    act(() => {
      StyleRegistry.unregister(lateTheme.id);
    });
    expect(result.current).toBe(fallbackTheme);
  });
});
