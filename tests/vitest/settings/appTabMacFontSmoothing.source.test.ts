import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AppearanceTab macOS font smoothing source contract', () => {
  it('defines a dedicated macOS font smoothing setting row with persistence and settings reload signaling', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/settings/components/AppearanceTab.tsx'), 'utf8');

    expect(source).toContain("const MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY = 'macos.native_font_smoothing';");
    expect(source).toContain("title={t('settings:theme.font_smoothing_title', 'macOS 原生字体平滑')}");
    expect(source).toContain("settings:theme.font_smoothing_description");
    expect(source).toContain('setMacosNativeFontSmoothingEnabled');
    expect(source).toContain("save_setting', {");
    expect(source).toContain('window.dispatchEvent');
    expect(source).toContain('macosFontSmoothing: true');
    expect(source).toContain('settingKey: MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY');
  });
});
