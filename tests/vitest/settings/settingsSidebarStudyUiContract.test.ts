import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings sidebar study-ui contract', () => {
  const settingsSidebarSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/SettingsSidebar.tsx'),
    'utf-8'
  );
  const settingsSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/Settings.tsx'),
    'utf-8'
  );
  const settingsNavigationSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/useSettingsNavigation.tsx'),
    'utf-8'
  );
  const sidebarSettingsSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/sidebarSettings.ts'),
    'utf-8'
  );
  const sharedAppCssSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');

  it('keeps the settings sidebar on the same study-ui typography path as the main sidebar', () => {
    expect(settingsSidebarSource).toContain('font-sidebar-study-ui');
    expect(settingsSidebarSource).toContain('SETTINGS_BACK_BUTTON_LABEL');
    expect(settingsSidebarSource).toContain('SETTINGS_NAV_ITEM_LABEL_CLASS_NAME');
    expect(settingsSidebarSource).toContain("className={`truncate ${SETTINGS_NAV_ITEM_LABEL_CLASS_NAME}`}");
    expect(settingsSidebarSource).not.toContain('text-[14px]');
    expect(settingsSidebarSource).not.toContain('text-[color:var(--sidebar-quiet-active-foreground)]');
  });

  it('collapses the desktop settings sidebar fully out of view instead of leaving an icon rail', () => {
    expect(settingsSidebarSource).toContain("'overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]'");
    expect(settingsSidebarSource).toContain("globalLeftPanelCollapsed ? 'w-0' : 'w-[var(--shell-navigation-width)]'");
    expect(settingsSidebarSource).not.toContain("globalLeftPanelCollapsed ? 'w-14' : 'w-[var(--shell-navigation-width)]'");
  });

  it('uses the shared desktop shell navigation width so settings matches the main workspace width', () => {
    expect(settingsSidebarSource).toContain("'w-[var(--shell-navigation-width)]'");
    expect(settingsSidebarSource).not.toContain("'w-[17rem]'");
  });

  it('keeps the shared settings sidebar constants aligned with study-ui', () => {
    expect(sidebarSettingsSource).toContain('SETTINGS_BACK_BUTTON_LABEL');
    expect(sidebarSettingsSource).toContain('"返回主页"');
    expect(sidebarSettingsSource).toContain('SETTINGS_NAV_ITEM_LABEL_CLASS_NAME');
    expect(sidebarSettingsSource).toContain('"settings-nav-item-label"');
  });

  it('defines the settings nav label utility so labels stay on the sidebar foreground token', () => {
    expect(sharedAppCssSource).toMatch(/\.settings-nav-item-label\s*\{[\s\S]*color:\s*var\(--shell-navigation-foreground\);/);
    expect(sharedAppCssSource).toMatch(/\[data-theme="dark"\]\s+\.settings-nav-item-label\s*\{[\s\S]*color:\s*var\(--shell-navigation-foreground\);/);
  });

  it('uses phosphor icons for the settings sidebar navigation set', () => {
    expect(settingsSidebarSource).toContain("@phosphor-icons/react");
    expect(settingsSidebarSource).not.toContain("from 'lucide-react'");
    expect(settingsSource).toContain("@phosphor-icons/react");
    expect(settingsNavigationSource).toContain("{ value: 'apis', icon: Robot");
    expect(settingsNavigationSource).toContain("{ value: 'models', icon: Flask");
    expect(settingsNavigationSource).toContain("{ value: 'general', icon: SlidersHorizontal");
    expect(settingsNavigationSource).toContain("{ value: 'appearance', icon: Palette");
    expect(settingsNavigationSource).toContain("{ value: 'mcp', icon: Plug");
    expect(settingsNavigationSource).toContain("{ value: 'search', icon: Globe");
    expect(settingsNavigationSource).toContain("{ value: 'statistics', icon: ChartBar");
    expect(settingsNavigationSource).toContain("{ value: 'data-governance', icon: Shield");
    expect(settingsNavigationSource).toContain("{ value: 'params', icon: Wrench");
    expect(settingsNavigationSource).toContain("{ value: 'shortcuts', icon: Keyboard");
    expect(settingsNavigationSource).toContain("{ value: 'about', icon: BookOpen");
    expect(settingsNavigationSource).not.toContain("{ value: 'app', icon: Palette");
  });
});
