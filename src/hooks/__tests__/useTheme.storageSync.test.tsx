import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTheme } from '../useTheme';
import { installCrossTabSettingsSync } from '../useAppInitialization';

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  saveSetting: vi.fn().mockResolvedValue(undefined),
}));

describe('cross-tab storage sync', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-boot-theme');
    document.documentElement.removeAttribute('data-theme-palette');
    document.documentElement.removeAttribute('data-auto-collapse-thinking');
    document.documentElement.style.cssText = '';
    document.body.className = '';
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('syncs theme mode, palette, and customColor across tabs via window storage events', () => {
    localStorage.setItem('dstu-theme-mode', 'light');
    const { result, unmount } = renderHook(() => useTheme());

    expect(result.current.mode).toBe('light');
    expect(result.current.isDarkMode).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      localStorage.setItem('dstu-theme-mode', 'dark');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'dstu-theme-mode',
          oldValue: 'light',
          newValue: 'dark',
        }),
      );
    });

    expect(result.current.mode).toBe('dark');
    expect(result.current.isDarkMode).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');

    act(() => {
      localStorage.setItem('dstu-theme-palette', 'custom');
      localStorage.setItem('dstu-theme-custom-color', '#123456');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'dstu-theme-custom-color',
          newValue: '#123456',
        }),
      );
    });

    expect(result.current.palette).toBe('custom');
    expect(result.current.customColor).toBe('#123456');

    unmount();
  });

  it('syncs font family, font scale, thread width ratio, and thinking auto-collapse across tabs', () => {
    const stop = installCrossTabSettingsSync();
    try {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'ui.fontScale',
          newValue: '1.2',
        }),
      );
      expect(document.documentElement.style.getPropertyValue('--font-size-scale')).toBe('1.2');

      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'ui.fontFamily',
          newValue: 'inter',
        }),
      );
      expect(document.documentElement.style.getPropertyValue('--font-family')).toContain('"Inter"');

      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'chat.threadWidthRatio',
          newValue: '92',
        }),
      );
      expect(document.documentElement.style.getPropertyValue('--chat-thread-ratio')).toBe('92');

      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'thinking.auto_collapse',
          newValue: 'false',
        }),
      );
      expect(document.documentElement.getAttribute('data-auto-collapse-thinking')).toBe('false');
    } finally {
      stop();
    }
  });
});
