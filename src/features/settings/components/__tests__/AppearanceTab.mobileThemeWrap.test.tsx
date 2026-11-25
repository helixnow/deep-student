import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AppearanceTab } from '../AppearanceTab';

const getSettingMock = vi.fn().mockResolvedValue(null);
const saveSettingMock = vi.fn().mockResolvedValue(null);
const invokeMock = vi.fn().mockResolvedValue(null);

const appearanceCopy: Record<string, string> = {
  'settings:theme.mode_label': '主题模式',
  'settings:theme.modes.light': '亮色',
  'settings:theme.modes.dark': '暗色',
  'settings:theme.system_default': '系统',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) => {
      if (appearanceCopy[key]) return appearanceCopy[key];
      if (typeof options === 'string') return options;
      if (typeof options === 'object' && typeof options.defaultValue === 'string') {
        return options.defaultValue;
      }
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
    if (command === 'get_setting') return getSettingMock(payload?.key);
    if (command === 'save_setting') return saveSettingMock(payload?.key, payload?.value);
    return Promise.resolve(null);
  },
}));

describe('SOTA08 mobile AppearanceTab theme segmented control & renderer_capabilities copy', () => {
  beforeEach(() => {
    getSettingMock.mockReset().mockResolvedValue(null);
    saveSettingMock.mockReset().mockResolvedValue(null);
    invokeMock.mockClear();
  });

  it('prevents 2-char CJK theme labels from wrapping vertically at 360px + 125% zoom', () => {
    render(
      <AppearanceTab
        uiZoom={1.25}
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
        themeMode="dark"
        isSystemDark={true}
        setThemeMode={vi.fn()}
        themePalette="default"
        setThemePalette={vi.fn()}
        customColor="#6366f1"
        setCustomColor={vi.fn()}
        isTauriEnvironment={false}
        invoke={invokeMock}
      />,
    );

    const group = screen.getByRole('radiogroup', { name: '主题模式' });
    expect(group.className).toContain('flex-nowrap');

    for (const labelText of ['亮色', '暗色', '系统']) {
      const labelSpan = screen.getByText(labelText);
      expect(labelSpan.className).toContain('whitespace-nowrap');

      const radioButton = labelSpan.closest('[role="radio"]');
      expect(radioButton).not.toBeNull();
      expect(radioButton?.className).toContain('px-2');
      expect(radioButton?.className).toContain('sm:px-3.5');
      expect(radioButton?.className).toContain('whitespace-nowrap');

      const icon = radioButton?.querySelector('svg');
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute('class') ?? '').toContain('shrink-0');
    }

    const appCss = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');
    const segmentedLabelMatch = appCss.match(/\.study-shell-segmented-label\s*\{[^}]*\}/);
    expect(segmentedLabelMatch?.[0]).toContain('white-space: nowrap;');
  });

  it('uses plain learner-friendly Chinese for all 8 renderer_capabilities descriptions with full key parity', () => {
    const zhSettings = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/settings.json'), 'utf-8'),
    ) as { renderer_capabilities: Record<string, string> };
    const enSettings = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/locales/en-US/settings.json'), 'utf-8'),
    ) as { renderer_capabilities: Record<string, string> };

    expect(Object.keys(zhSettings.renderer_capabilities).sort()).toEqual(
      Object.keys(enSettings.renderer_capabilities).sort(),
    );

    const descriptionKeys = [
      'chemicalStructures_description',
      'charts_description',
      'graphviz_description',
      'music_description',
      'timing_description',
      'chemicalFiles_description',
      'molecular3d_description',
      'geojson_description',
    ];

    const forbiddenJargon = [
      'Vega-Lite',
      'Graphviz',
      'DOT',
      'WaveDrom',
      'Molfile',
      'SDF',
      'PDB',
      'GeoJSON',
      'SMILES',
      'ABC 记谱法',
    ];

    for (const key of descriptionKeys) {
      const value = zhSettings.renderer_capabilities[key];
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(6);
      for (const jargon of forbiddenJargon) {
        expect(value).not.toContain(jargon);
      }
    }
  });
});
