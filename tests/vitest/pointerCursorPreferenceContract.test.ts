import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('pointer cursor preference contract', () => {
  it('surfaces a persisted pointer cursor toggle in appearance settings', () => {
    const appearanceTabSource = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/AppearanceTab.tsx'),
      'utf8',
    );
    const zhSettingsSource = readFileSync(
      resolve(process.cwd(), 'src/locales/zh-CN/settings.json'),
      'utf8',
    );
    const enSettingsSource = readFileSync(
      resolve(process.cwd(), 'src/locales/en-US/settings.json'),
      'utf8',
    );

    expect(appearanceTabSource).toContain("const POINTER_CURSOR_SETTING_KEY = 'ui.pointer_cursor'");
    expect(appearanceTabSource).toContain("document.documentElement.setAttribute('data-pointer-cursor', String(enabled))");
    expect(appearanceTabSource).toContain("document.documentElement.setAttribute('data-pointer-cursor', String(checked))");
    expect(appearanceTabSource).toContain("pointerCursor: true");
    expect(appearanceTabSource).toContain("settings:theme.pointer_cursor_title");
    expect(appearanceTabSource).toContain("settings:theme.pointer_cursor_description");

    expect(zhSettingsSource).toContain('"pointer_cursor_title": "使用指针光标"');
    expect(zhSettingsSource).toContain('"pointer_cursor_description": "悬停交互元素时切换为指针光标。"');
    expect(enSettingsSource).toContain('"pointer_cursor_title": "Use Pointer Cursor"');
    expect(enSettingsSource).toContain('"pointer_cursor_description": "Switch to a pointer cursor when hovering interactive elements."');
  });

  it('restores the preference at app startup and gates global cursor rules through the root dataset', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const cursorStyleSource = readFileSync(
      resolve(process.cwd(), 'src/styles/native-feel/cursors.css'),
      'utf8',
    );

    expect(appSource).toContain("const POINTER_CURSOR_SETTING_KEY = 'ui.pointer_cursor'");
    expect(appSource).toContain('document.documentElement.dataset.pointerCursor = enabled ? \'true\' : \'false\'');
    expect(appSource).toContain("event?.detail?.settingKey === POINTER_CURSOR_SETTING_KEY");
    expect(appSource).toContain('const loadPointerCursorSetting = async () => {');
    expect(appSource).toContain("applyPointerCursorPreference(String(val ?? '').trim() !== 'false')");

    expect(cursorStyleSource).toContain(':root:not([data-pointer-cursor="false"]) :where(');
    expect(cursorStyleSource).toContain(':root[data-pointer-cursor="false"] :where(');
    expect(cursorStyleSource).toContain('.cursor-pointer');
    expect(cursorStyleSource).toContain('cursor: default !important;');
  });
});
