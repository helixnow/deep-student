import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AppearanceTab } from '../AppearanceTab';

const getSettingMock = vi.fn();
const saveSettingMock = vi.fn();
const invokeMock = vi.fn((command: string, payload?: Record<string, unknown>) => {
  if (command === 'save_setting') {
    return saveSettingMock(payload?.key, payload?.value);
  }
  return Promise.resolve(null);
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) => {
      if (typeof options === 'string') return options;
      if (typeof options === 'object' && typeof options.defaultValue === 'string') return options.defaultValue;
      return key;
    },
  }),
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, payload?: Record<string, unknown>) => {
    if (command === 'get_setting') {
      return getSettingMock(payload?.key);
    }
    if (command === 'save_setting') {
      return saveSettingMock(payload?.key, payload?.value);
    }
    return Promise.reject(new Error(`Unexpected command: ${command}`));
  },
}));

describe('AppearanceTab pointer cursor preference', () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    saveSettingMock.mockReset();
    invokeMock.mockClear();
    document.documentElement.removeAttribute('data-pointer-cursor');
  });

  it('loads the pointer cursor preference and toggles the document attribute', async () => {
    getSettingMock.mockImplementation(async (key?: unknown) => {
      if (key === 'ui.pointer_cursor') return 'true';
      if (key === 'sidebar.translucent') return 'false';
      if (key === 'macos.native_font_smoothing') return 'true';
      return null;
    });

    render(
      <AppearanceTab
        uiZoom={1}
        zoomLoading={false}
        zoomSaving={false}
        zoomStatus={{ type: 'idle' }}
        handleZoomChange={vi.fn()}
        handleZoomReset={vi.fn()}
        uiFont="inter"
        fontLoading={false}
        fontSaving={false}
        handleFontChange={vi.fn()}
        handleFontReset={vi.fn()}
        uiFontSize={1}
        fontSizeLoading={false}
        fontSizeSaving={false}
        handleFontSizeChange={vi.fn()}
        handleFontSizeReset={vi.fn()}
        themeMode="light"
        isSystemDark={false}
        setThemeMode={vi.fn()}
        themePalette="default"
        setThemePalette={vi.fn()}
        customColor="#6366f1"
        setCustomColor={vi.fn()}
        isTauriEnvironment
        invoke={invokeMock}
      />,
    );

    expect(await screen.findByText('使用指针光标')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-pointer-cursor')).toBe('true');
    });

    fireEvent.click(screen.getByRole('switch', { name: '使用指针光标' }));

    await waitFor(() => {
      expect(saveSettingMock).toHaveBeenCalledWith('ui.pointer_cursor', 'false');
      expect(document.documentElement.getAttribute('data-pointer-cursor')).toBe('false');
    });
  });
});
