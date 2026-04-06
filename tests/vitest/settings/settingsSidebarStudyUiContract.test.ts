import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings sidebar study-ui contract', () => {
  const settingsSidebarSource = readFileSync(
    resolve(process.cwd(), 'src/components/settings/SettingsSidebar.tsx'),
    'utf-8'
  );
  const settingsSource = readFileSync(
    resolve(process.cwd(), 'src/components/Settings.tsx'),
    'utf-8'
  );
  const sidebarSettingsSource = readFileSync(
    resolve(process.cwd(), 'src/components/settings/sidebarSettings.ts'),
    'utf-8'
  );
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');

  it('keeps the settings sidebar on the same study-ui typography path as the main sidebar', () => {
    expect(settingsSidebarSource).toContain('font-sidebar-study-ui');
    expect(settingsSidebarSource).toContain('SETTINGS_BACK_BUTTON_LABEL');
    expect(settingsSidebarSource).toContain('SETTINGS_NAV_ITEM_LABEL_CLASS_NAME');
    expect(settingsSidebarSource).toContain("className={`truncate ${SETTINGS_NAV_ITEM_LABEL_CLASS_NAME}`}");
    expect(settingsSidebarSource).not.toContain('text-[14px]');
    expect(settingsSidebarSource).not.toContain('text-[color:var(--sidebar-quiet-active-foreground)]');
  });

  it('keeps the shared settings sidebar constants aligned with study-ui', () => {
    expect(sidebarSettingsSource).toContain('SETTINGS_BACK_BUTTON_LABEL');
    expect(sidebarSettingsSource).toContain('"返回主页"');
    expect(sidebarSettingsSource).toContain('SETTINGS_NAV_ITEM_LABEL_CLASS_NAME');
    expect(sidebarSettingsSource).toContain('"settings-nav-item-label"');
  });

  it('defines the settings nav label utility so labels stay on the sidebar foreground token', () => {
    expect(appCssSource).toMatch(/\.settings-nav-item-label\s*\{[\s\S]*color:\s*var\(--shell-navigation-foreground\);/);
    expect(appCssSource).toMatch(/\[data-theme="dark"\]\s+\.settings-nav-item-label\s*\{[\s\S]*color:\s*var\(--shell-navigation-foreground\);/);
  });

  it('uses phosphor icons for the settings sidebar navigation set', () => {
    expect(settingsSidebarSource).toContain("@phosphor-icons/react");
    expect(settingsSidebarSource).not.toContain("from 'lucide-react'");
    expect(settingsSource).toContain("@phosphor-icons/react");
    expect(settingsSource).toContain("{ value: 'apis', icon: Robot");
    expect(settingsSource).toContain("{ value: 'models', icon: Flask");
    expect(settingsSource).toContain("{ value: 'app', icon: Palette");
    expect(settingsSource).toContain("{ value: 'mcp', icon: Plug");
    expect(settingsSource).toContain("{ value: 'search', icon: Globe");
    expect(settingsSource).toContain("{ value: 'statistics', icon: ChartBar");
    expect(settingsSource).toContain("{ value: 'data-governance', icon: Shield");
    expect(settingsSource).toContain("{ value: 'params', icon: Wrench");
    expect(settingsSource).toContain("{ value: 'shortcuts', icon: Keyboard");
    expect(settingsSource).toContain("{ value: 'about', icon: BookOpen");
  });
});
