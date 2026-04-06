import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { AppTab } from '@/components/settings/AppTab';
import type { ThemeMode } from '@/hooks/useTheme';

describe('AppTab theme mode settings', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  const renderAppTab = (overrides?: {
    themeMode?: ThemeMode;
    isSystemDark?: boolean;
    setThemeMode?: (mode: ThemeMode) => void;
  }) => {
    const setThemeMode = overrides?.setThemeMode ?? vi.fn();

    render(
      <AppTab
        uiZoom={1}
        zoomLoading={false}
        zoomSaving={false}
        zoomStatus={{ type: 'idle' }}
        handleZoomChange={vi.fn(async () => {})}
        handleZoomReset={vi.fn()}
        uiFont="system"
        fontLoading={false}
        fontSaving={false}
        handleFontChange={vi.fn(async () => {})}
        handleFontReset={vi.fn()}
        uiFontSize={1}
        fontSizeLoading={false}
        fontSizeSaving={false}
        handleFontSizeChange={vi.fn(async () => {})}
        handleFontSizeReset={vi.fn()}
        themeMode={overrides?.themeMode ?? 'auto'}
        isSystemDark={overrides?.isSystemDark ?? false}
        setThemeMode={setThemeMode}
        themePalette="default"
        setThemePalette={vi.fn()}
        customColor="#0952c6"
        setCustomColor={vi.fn()}
        topbarTopMargin="0"
        setTopbarTopMargin={vi.fn()}
        logTypeForOpen="backend"
        setLogTypeForOpen={vi.fn()}
        showRawRequest={false}
        setShowRawRequest={vi.fn()}
        isTauriEnvironment={true}
        invoke={invokeMock as never}
      />
    );

    return { setThemeMode };
  };

  it('shows appearance theme controls with light, dark, and system default options', () => {
    renderAppTab();

    expect(screen.getByText('外观 / 主题')).toBeInTheDocument();
    expect(screen.getByText('使用浅色、深色，或匹配系统设置')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '浅色' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '深色' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '系统默认' })).toBeInTheDocument();

    const segmentedGroup = screen.getByRole('group', { name: '选择主题模式' });
    expect(segmentedGroup.className).toContain('study-shell-segmented');
    expect(screen.getByRole('button', { name: '浅色' }).className).toContain('study-shell-segmented-button');
  });

  it('renders the selected theme mode as a shallow gray pill instead of the plain ghost button style', () => {
    renderAppTab({ themeMode: 'light' });

    const selectedButton = screen.getByRole('button', { name: '浅色' });
    const unselectedButton = screen.getByRole('button', { name: '深色' });

    expect(selectedButton).toHaveAttribute('data-selected', 'true');
    expect(selectedButton.className).toContain('!bg-[color:var(--interactive-selected)]');
    expect(selectedButton.className).toContain('hover:!bg-[color:var(--interactive-selected)]');
    expect(unselectedButton.className).toContain('hover:!bg-[color:var(--interactive-hover)]');
  });

  it('uses the same segmented pill shape for language selection and removes the large row hover frame', () => {
    renderAppTab();

    const zhButton = screen.getByRole('button', { name: '中文' });
    const enButton = screen.getByRole('button', { name: 'English' });

    expect(zhButton.className).toContain('study-shell-segmented-button');
    expect(enButton.className).toContain('study-shell-segmented-button');
    expect(enButton).toHaveAttribute('data-selected', 'true');
    expect(enButton.className).toContain('!bg-[color:var(--interactive-selected)]');

    const languageRow = screen.getByText('settings:language.title').closest('div.group');
    expect(languageRow).not.toBeNull();
    expect(languageRow?.className).not.toContain('hover:bg-[color:var(--button-utility-hover)]');
  });

  it('switches theme mode and persists the selected value', async () => {
    const { setThemeMode } = renderAppTab({ themeMode: 'light', isSystemDark: true });

    fireEvent.click(screen.getByRole('button', { name: '深色' }));

    expect(setThemeMode).toHaveBeenCalledWith('dark');

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('save_setting', { key: 'theme', value: 'dark' });
    });
  });
});
