import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop shell sidebar collapse contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const settingsSource = readFileSync(resolve(process.cwd(), 'src/features/settings/components/Settings.tsx'), 'utf-8');
  const settingsCssSource = readFileSync(resolve(process.cwd(), 'src/features/settings/styles/settings.css'), 'utf-8');
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

  it('reads the shared left-panel collapsed state when computing desktop shell navigation width', () => {
    expect(appSource).toContain("const leftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);");
    expect(appSource).toContain("const desktopNavigationWidth = !isSmallScreen && leftPanelCollapsed ? 0 : shellSidebarWidth;");
    expect(appSource).not.toContain("currentView !== 'settings' && leftPanelCollapsed ? 0 : shellSidebarWidth");
    expect(appSource).toContain("'--shell-navigation-width': `${desktopNavigationWidth}px`");
    expect(appSource).toContain('gridTemplateColumns: `${desktopNavigationWidth}px minmax(0, 1fr)`');
    expect(appSource).toContain('desktop-shell-titlebar fixed top-0 left-0 right-0 z-[1100] grid transition-[grid-template-columns] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none');
  });

  it('declares currentView before using it to compute desktop shell navigation width', () => {
    const currentViewIndex = appSource.indexOf("const [currentView, setCurrentViewRaw] = useState<CurrentView>('chat-v2');");
    const desktopNavigationWidthIndex = appSource.indexOf("const desktopNavigationWidth = !isSmallScreen && leftPanelCollapsed ? 0 : shellSidebarWidth;");

    expect(currentViewIndex).toBeGreaterThanOrEqual(0);
    expect(desktopNavigationWidthIndex).toBeGreaterThan(currentViewIndex);
  });

  it('adds a titlebar leading inset when the desktop sidebar is fully collapsed so the header content does not overlap the floating controls', () => {
    expect(appSource).toContain('const desktopTitlebarLeadingInset = !isSmallScreen && leftPanelCollapsed');
    expect(appSource).not.toContain("const desktopTitlebarLeadingInset = !isSmallScreen && currentView !== 'settings' && leftPanelCollapsed");
    expect(appSource).toContain("style={{ paddingLeft: `${20 + desktopTitlebarLeadingInset}px` }}");
    expect(appSource).toContain('transition-[padding-left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none');
  });

  it('keeps the collapse affordance alive as a floating titlebar accessory instead of letting it disappear with the sidebar column', () => {
    expect(appSource).toContain('const shouldUseDesktopFloatingAccessory = !isSmallScreen;');
    expect(appSource).not.toContain("const shouldUseDesktopFloatingAccessory = !isSmallScreen && currentView !== 'settings';");
    expect(appSource).toContain('const desktopCollapsedLeadingWidth = 148;');
    expect(appSource).toContain('const desktopFloatingAccessoryWidth = desktopCollapsedLeadingWidth;');
    expect(appSource).not.toContain('const desktopFloatingAccessoryWidth = leftPanelCollapsed');
    expect(appSource).toContain('const desktopSidebarAccessoryContent = (');
    expect(appSource).toContain('<DesktopSidebarAccessory');
    expect(appSource).toContain('transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none');
    expect(appSource).not.toContain('pointer-events-none absolute z-20 transition-[width,opacity]');
    expect(appSource).toContain('width: `${desktopFloatingAccessoryWidth}px`');
    expect(appSource).toContain('opacity: 1,');
    expect(appSource).toContain('pointer-events-auto inline-flex h-full max-w-full items-center justify-between gap-1.5 overflow-hidden pr-1.5');
    expect(appSource).toContain('{shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
    expect(appSource).not.toContain('{leftPanelCollapsed && shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
    expect(appSource).not.toContain('{!leftPanelCollapsed && shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
    expect(appSource).toContain("window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.CHAT_NEW_SESSION));");
  });

  it('uses a plain frame icon when collapsed and a left-rail frame icon when expanded', () => {
    expect(appSource).toContain('function SidebarFrameIcon()');
    expect(appSource).toContain('function SidebarFrameWithLeftRailIcon()');
    expect(appSource).toContain('collapsed ? <SidebarFrameIcon /> : <SidebarFrameWithLeftRailIcon />');
    const plainFrameIconSource = appSource.slice(
      appSource.indexOf('function SidebarFrameIcon()'),
      appSource.indexOf('function SidebarFrameWithLeftRailIcon()')
    );
    const leftRailFrameIconSource = appSource.slice(
      appSource.indexOf('function SidebarFrameWithLeftRailIcon()'),
      appSource.indexOf('function SidebarUpdateBadge')
    );
    expect(plainFrameIconSource).toContain('className="size-[18px] fill-none"');
    expect(leftRailFrameIconSource).toContain('className="size-[18px] fill-none"');
    expect(appSource).not.toContain('PanelLeftOpen');
    expect(appSource).not.toContain('PanelLeftClose');
    expect(appSource).not.toContain('<SidebarDockIcon />');
  });

  it('clips and animates the titlebar navigation cell with the same sidebar width rhythm as the body column', () => {
    expect(appSource).toContain(
      "'desktop-shell-header-cell desktop-shell-header-cell--nav relative z-10 flex min-w-0 items-center justify-end overflow-hidden transition-[padding] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none'"
    );
    expect(appSource).toContain("leftPanelCollapsed ? 'px-0' : 'px-4'");
  });

  it('animates the accessory internals and back-forward rhythm with the same motion vocabulary as study-ui', () => {
    expect(appSource).toContain('transition-[width,opacity,margin-left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none');
    expect(appSource).toContain('transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none');
    expect(appSource).toContain('transition-[transform,opacity,margin-right] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none');
  });

  it('renders the active desktop shell sidebar for every desktop route so width transitions can animate', () => {
    expect(appSource).toContain("const desktopShellSidebarElement = currentView === 'settings' ? settingsShellSidebarElement : sidebarElement;");
    expect(appSource).toContain('{!isSmallScreen ? (');
    expect(appSource).not.toContain("{!isSmallScreen && currentView !== 'settings' ? (");
    expect(appSource).toContain("'overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]'");
    expect(appSource).toContain("leftPanelCollapsed ? 'w-0' : 'w-[var(--shell-navigation-width)]'");
    expect(appSource).toContain('{desktopShellSidebarElement}');
  });

  it('lets ModernSidebar behave like a fill-content shell so the outer app column owns the collapse animation', () => {
    expect(sidebarSource).not.toContain("'overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]'");
    expect(sidebarSource).not.toContain("sidebarCollapsed ? 'w-0' : 'w-[var(--shell-navigation-width)]'");
    expect(sidebarSource).toMatch(
      /className="font-sidebar-study-ui[^"]*\bflex\b[^"]*\bh-full\b[^"]*\bmin-h-0\b[^"]*\bw-full\b[^"]*\bmin-w-0\b[^"]*\bflex-col\b[^"]*\boverflow-hidden\b/
    );
  });

  it('rounds the visible desktop workspace edge across the fixed titlebar and body', () => {
    expect(appSource).toContain("const isDesktopSidebarSurfaceVisible = !isSmallScreen && !leftPanelCollapsed;");
    expect(appSource).toContain('data-sidebar-visible={isDesktopSidebarSurfaceVisible ? \'true\' : \'false\'}');
    expect(appCssSource).toContain('--shell-workspace-edge-radius: 24px;');
    expect(appCssSource).toMatch(/\[data-shell-role="app-shell"\]\[data-sidebar-visible="true"\]\s*\{[\s\S]*background:\s*var\(--shell-navigation-surface\);/);
    expect(appCssSource).toMatch(/\.desktop-shell-header-cell--workspace\[data-sidebar-visible="true"\]\s*\{[\s\S]*border-top-left-radius:\s*var\(--shell-workspace-edge-radius\);/);
    expect(appCssSource).toMatch(/\.desktop-shell-workspace\[data-sidebar-visible="true"\]\s*\{[\s\S]*border-bottom-left-radius:\s*var\(--shell-workspace-edge-radius\);/);
    expect(appCssSource).toMatch(/\.desktop-shell-workspace\[data-sidebar-visible="true"\]\s*\{[\s\S]*border-left:\s*1px solid var\(--shell-navigation-border\);/);
  });

  it('renders the settings custom left rail in the global desktop shell nav slot', () => {
    expect(appSource).toContain("import { SettingsShellSidebar } from '@/features/settings';");
    expect(appSource).toContain('const settingsShellSidebarElement = useMemo(() => (');
    expect(appSource).toContain('<SettingsShellSidebar');
    expect(appSource).toContain('globalLeftPanelCollapsed={leftPanelCollapsed}');
    expect(appSource).toContain("onBack={() => setCurrentView('chat-v2')}");
    expect(appSource).toContain("const desktopShellSidebarElement = currentView === 'settings' ? settingsShellSidebarElement : sidebarElement;");
  });

  it('keeps desktop settings content inside the shared workspace boundary instead of drawing its own shell', () => {
    expect(settingsSource).toContain("import { SettingsShellSidebar } from './SettingsShellSidebar';");
    expect(settingsSource).toContain("import { useSettingsNavigation } from './useSettingsNavigation';");
    expect(settingsSource).toContain("import { useSettingsShellStore } from '@/stores/settingsShellStore';");
    expect(settingsSource).not.toContain("const isDesktopSettingsSidebarVisible = !isSmallScreen && !globalLeftPanelCollapsed;");
    expect(settingsSource).not.toContain("settings-main-pane study-shell-pane study-shell-pane--flush-top");
    expect(settingsSource).not.toContain("data-sidebar-visible={!sheetMode && isDesktopSettingsSidebarVisible ? 'true' : 'false'}");
    expect(settingsCssSource).not.toContain('.settings-main-pane[data-sidebar-visible="true"]');
    expect(settingsCssSource).not.toMatch(/\.settings\s*\{[\s\S]*background:\s*var\(--shell-navigation-surface\);/);

    const desktopLayoutSource = settingsSource.slice(settingsSource.indexOf('// ===== 桌面端布局 ====='));
    expect(desktopLayoutSource).not.toContain('<MacTopSafeDragZone');
    expect(desktopLayoutSource).not.toContain('{renderSettingsSidebar()}');
    expect(desktopLayoutSource).toContain('{renderSettingsMainContent()}');
  });
});
