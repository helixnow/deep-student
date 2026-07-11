import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop shell sidebar collapse contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');
  const settingsSource = readFileSync(resolve(process.cwd(), 'src/features/settings/components/Settings.tsx'), 'utf-8');
  const settingsCssSource = readFileSync(resolve(process.cwd(), 'src/features/settings/styles/settings.css'), 'utf-8');
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
  const desktopShellIconsSource = readFileSync(resolve(process.cwd(), 'src/app/shell/DesktopShellIcons.tsx'), 'utf-8');

  it('reads the shared left-panel collapsed state when computing desktop shell navigation width', () => {
    expect(appSource).toContain("const leftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);");
    expect(appSource).toContain("const desktopNavigationWidth = workbenchActive");
    expect(appSource).toContain(": !isSmallScreen && leftPanelCollapsed ? 0 : shellSidebarWidth;");
    expect(appSource).not.toContain("currentView !== 'settings' && leftPanelCollapsed ? 0 : shellSidebarWidth");
    expect(appSource).toContain("'--shell-navigation-width': `${desktopNavigationWidth}px`");
    expect(appSource).toContain("'desktop-shell-titlebar fixed top-0 left-0 right-0 z-[1100] flex motion-reduce:transition-none'");
    expect(appSource).toContain("workbenchActive && 'desktop-shell-titlebar--workbench-chrome'");
    expect(appSource).toContain('width: `${desktopNavigationWidth}px`');
    expect(appSource).toContain('transition-[width,padding] duration-200 ease-[var(--panel-ease)] motion-reduce:transition-none');
  });

  it('declares currentView before using it to compute desktop shell navigation width', () => {
    const currentViewIndex = appSource.indexOf("const [currentView, setCurrentViewRaw] = useState<CurrentView>('chat-v2');");
    const desktopNavigationWidthIndex = appSource.indexOf("const desktopNavigationWidth = workbenchActive");

    expect(currentViewIndex).toBeGreaterThanOrEqual(0);
    expect(desktopNavigationWidthIndex).toBeGreaterThan(currentViewIndex);
  });

  it('adds a titlebar leading inset when the desktop sidebar is fully collapsed so the header content does not overlap the floating controls', () => {
    expect(appSource).toContain('const desktopTitlebarLeadingInset = !isSmallScreen && leftPanelCollapsed');
    expect(appSource).not.toContain("const desktopTitlebarLeadingInset = !isSmallScreen && currentView !== 'settings' && leftPanelCollapsed");
    expect(appSource).toContain("style={{ paddingLeft: `${20 + desktopTitlebarLeadingInset}px` }}");
    expect(appCssSource).toContain('transition: padding-left var(--page-slide-dur, 200ms) var(--ease-shell)');
  });

  it('keeps the collapse affordance alive as a floating titlebar accessory instead of letting it disappear with the sidebar column', () => {
    expect(appSource).toContain('const shouldUseDesktopFloatingAccessory = !isSmallScreen;');
    expect(appSource).not.toContain("const shouldUseDesktopFloatingAccessory = !isSmallScreen && currentView !== 'settings';");
    expect(appSource).toContain('const desktopCollapsedLeadingWidth = 148;');
    expect(appSource).toContain('const desktopFloatingAccessoryWidth = desktopCollapsedLeadingWidth;');
    expect(appSource).not.toContain('const desktopFloatingAccessoryWidth = leftPanelCollapsed');
    expect(appSource).toContain('const desktopSidebarAccessoryContent = (');
    expect(appSource).toContain('<DesktopSidebarAccessory');
    expect(appSource).toContain('transition-[opacity,transform] duration-200 ease-[var(--panel-ease)] motion-reduce:transition-none');
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
    expect(appSource).toContain("import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from './app/shell/DesktopShellIcons';");
    expect(desktopShellIconsSource).toContain('export function SidebarFrameIcon');
    expect(desktopShellIconsSource).toContain('export function SidebarFrameWithLeftRailIcon');
    expect(appSource).toContain('collapsed ? <SidebarFrameIcon /> : <SidebarFrameWithLeftRailIcon />');
    const plainFrameIconSource = desktopShellIconsSource.slice(
      desktopShellIconsSource.indexOf('export function SidebarFrameIcon'),
      desktopShellIconsSource.indexOf('export function SidebarFrameWithLeftRailIcon')
    );
    const leftRailFrameIconSource = desktopShellIconsSource.slice(
      desktopShellIconsSource.indexOf('export function SidebarFrameWithLeftRailIcon')
    );
    expect(plainFrameIconSource).toContain("className = 'size-[18px]'");
    expect(plainFrameIconSource).toContain('<rect x="4" y="5" width="16" height="14" rx="2" />');
    expect(leftRailFrameIconSource).toContain("className = 'size-[18px]'");
    expect(leftRailFrameIconSource).toContain('<path d="M9 5v14" />');
    expect(appSource).not.toContain('PanelLeftOpen');
    expect(appSource).not.toContain('PanelLeftClose');
    expect(appSource).not.toContain('<SidebarDockIcon />');
  });

  it('clips and animates the titlebar navigation cell with the same sidebar width rhythm as the body column', () => {
    expect(appSource).toContain(
      "'desktop-shell-header-cell desktop-shell-header-cell--nav relative z-10 flex min-w-0 shrink-0 items-center justify-end overflow-hidden transition-[width,padding] duration-200 ease-[var(--panel-ease)] motion-reduce:transition-none'"
    );
    expect(appSource).toContain("leftPanelCollapsed ? 'px-0' : 'px-4'");
    expect(appSource).toContain('width: `${desktopNavigationWidth}px`');
  });

  it('animates the accessory internals and back-forward rhythm with the same motion vocabulary as study-ui', () => {
    expect(appSource).toContain('transition-[opacity,transform] duration-200 ease-[var(--panel-ease)] motion-reduce:transition-none');
    expect(appSource).toContain('transition-[transform,opacity,margin-right] duration-200 ease-[var(--panel-ease)] motion-reduce:transition-none');
  });

  it('renders the active desktop shell sidebar for every desktop route so width transitions can animate', () => {
    expect(appSource).toContain("const desktopShellSidebarKind = currentView === 'settings'");
    expect(appSource).toContain(": currentView === 'todo'");
    expect(appSource).toContain("const desktopShellSidebarElement = desktopShellSidebarKind === 'settings'");
    expect(appSource).toContain(": desktopShellSidebarKind === 'todo'");
    expect(appSource).toContain('? todoShellSidebarElement');
    expect(appSource).toContain(': sidebarElement;');
    expect(appSource).toContain('{!isSmallScreen && !workbenchActive ? (');
    expect(appSource).not.toContain("{!isSmallScreen && currentView !== 'settings' ? (");
    expect(appSource).toContain("'overflow-hidden transition-[width] duration-200 ease-[var(--panel-ease)]'");
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
    expect(appSource).toContain("const isDesktopSidebarSurfaceVisible = !isSmallScreen && !leftPanelCollapsed && !workbenchActive;");
    expect(appSource).toContain('data-sidebar-visible={isDesktopSidebarSurfaceVisible ? \'true\' : \'false\'}');
    expect(appCssSource).toContain('--shell-workspace-edge-radius: 24px;');
    expect(appCssSource).toMatch(/\[data-shell-role="app-shell"\]\[data-sidebar-visible="true"\]\s*\{[\s\S]*background:\s*var\(--shell-navigation-surface\);/);
    expect(appCssSource).toMatch(/\.desktop-shell-titlebar\[data-sidebar-visible="true"\]\s*\{[\s\S]*var\(--shell-navigation-surface\) var\(--shell-navigation-width\),/);
    expect(appCssSource).toMatch(/\.desktop-shell-workspace\[data-sidebar-visible="true"\]\s*\{[\s\S]*overflow:\s*hidden;/);
    expect(appCssSource).toContain('background: var(--shell-workspace-panel);');
  });

  it('renders the settings custom left rail in the global desktop shell nav slot', () => {
    expect(appSource).toContain("import { SettingsShellSidebar } from '@/features/settings/components/SettingsShellSidebar';");
    expect(appSource).toContain('const settingsShellSidebarElement = useMemo(() => (');
    expect(appSource).toContain('<SettingsShellSidebar');
    expect(appSource).toContain('globalLeftPanelCollapsed={leftPanelCollapsed}');
    expect(appSource).toContain("onBack={() => setCurrentView('chat-v2')}");
    expect(appSource).toContain("const desktopShellSidebarKind = currentView === 'settings'");
    expect(appSource).toContain("const desktopShellSidebarElement = desktopShellSidebarKind === 'settings'");
    expect(appSource).toContain('? settingsShellSidebarElement');
  });

  it('keeps desktop settings content inside the shared workspace boundary instead of drawing its own shell', () => {
    // 桌面左栏由 App 的 desktopShellSidebarElement 承载；Settings 本体不再渲染任何自有侧栏
    // （移动端分区导航为 chip rail），因此不应再引入 SettingsShellSidebar
    expect(settingsSource).not.toContain("import { SettingsShellSidebar } from './SettingsShellSidebar';");
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
