import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { AppearanceTab } from '@/features/settings';
import type { ThemeMode, ThemePalette } from '@/hooks/useTheme';

describe('AppearanceTab theme mode settings', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  const renderAppearanceTab = (overrides?: {
    themeMode?: ThemeMode;
    isSystemDark?: boolean;
    setThemeMode?: (mode: ThemeMode) => void;
    setThemePalette?: (palette: ThemePalette) => void;
  }) => {
    const setThemeMode = overrides?.setThemeMode ?? vi.fn();
    const setThemePalette = overrides?.setThemePalette ?? vi.fn();

    const result = render(
      <AppearanceTab
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
        setThemePalette={setThemePalette}
        customColor="#0952c6"
        setCustomColor={vi.fn()}
        topbarTopMargin="0"
        setTopbarTopMargin={vi.fn()}
        logTypeForOpen="backend"
        setLogTypeForOpen={vi.fn()}
        isTauriEnvironment={true}
        invoke={invokeMock as never}
      />
    );

    return { ...result, setThemeMode, setThemePalette };
  };

  it('renders the theme controls, persists mode changes, and shows a single-row accent picker', () => {
    const { container, setThemeMode, setThemePalette } = renderAppearanceTab({ themeMode: 'light', isSystemDark: true });

    expect(screen.getByText('外观 / 主题')).toBeInTheDocument();
    expect(screen.getByText('使用浅色、深色，或匹配系统设置')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '浅色' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '深色' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '系统默认' })).toBeInTheDocument();

    const segmentedGroup = screen.getByRole('radiogroup', { name: '选择主题模式' });
    expect(segmentedGroup.className).toContain('study-shell-segmented');
    expect(screen.getByRole('radio', { name: '浅色' }).className).toContain('study-shell-segmented-button');

    const selectedButton = screen.getByRole('radio', { name: '浅色' });
    const unselectedButton = screen.getByRole('radio', { name: '深色' });

    // Behavioural contracts only: selection state is advertised via aria-
    // checked + data-selected, and every option carries the shared primitive
    // hook class. Implementation-level hover/background utility classes are
    // intentionally not asserted here — the sliding-thumb refactor moved the
    // highlight off the button and onto a sibling, so pinning specific
    // background utility names would re-couple tests to internal styling.
    expect(selectedButton).toHaveAttribute('data-selected', 'true');
    expect(selectedButton).toHaveAttribute('aria-checked', 'true');
    expect(unselectedButton).toHaveAttribute('data-selected', 'false');
    expect(unselectedButton).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('radio', { name: '深色' }));

    expect(setThemeMode).toHaveBeenCalledWith('dark');
    expect(invokeMock).toHaveBeenCalledWith('save_setting', { key: 'theme', value: 'dark' });

    // Phase 3.1: 调色板从 9 张卡片降级为单行圆点。
    // 必须不再渲染任何旧版的 card / preview slot。
    expect(container.querySelector('[data-slot="theme-palette-card"]')).toBeNull();
    expect(container.querySelector('[data-slot="theme-palette-card-preview"]')).toBeNull();
    expect(container.querySelector('[data-slot="theme-palette-preview-rail"]')).toBeNull();
    expect(container.querySelector('[data-slot="theme-palette-preview-panel"]')).toBeNull();
    expect(container.querySelector('[data-slot="theme-palette-preview-action"]')).toBeNull();

    // AccentPicker：8 个预设圆点 + 1 个自选圆点。
    const accentDots = container.querySelectorAll('[data-slot="accent-dot"]');
    expect(accentDots.length).toBe(8);
    expect(container.querySelector('[data-slot="accent-dot-custom"]')).not.toBeNull();

    const accentGroup = screen.getByRole('radiogroup', { name: '强调色' });
    expect(accentGroup).toBeInTheDocument();

    // 点击 purple 圆点应调用 setThemePalette('purple')
    const purpleDot = accentGroup.querySelector('[data-accent-key="purple"]') as HTMLElement | null;
    expect(purpleDot).not.toBeNull();
    fireEvent.click(purpleDot!);
    expect(setThemePalette).toHaveBeenCalledWith('purple');
  });
});
