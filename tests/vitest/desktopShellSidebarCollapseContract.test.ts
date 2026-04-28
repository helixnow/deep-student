import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop shell sidebar collapse contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
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
    expect(appSource).toContain("const desktopTitlebarLeadingInset = !isSmallScreen && currentView !== 'settings' && leftPanelCollapsed");
    expect(appSource).toContain("style={{ paddingLeft: `${20 + desktopTitlebarLeadingInset}px` }}");
    expect(appSource).toContain('transition-[padding-left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none');
  });

  it('keeps the collapse affordance alive as a floating titlebar accessory instead of letting it disappear with the sidebar column', () => {
    expect(appSource).toContain("const shouldUseDesktopFloatingAccessory = !isSmallScreen && currentView !== 'settings';");
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

  it('keeps rendering the global ModernSidebar on desktop non-settings routes so width transitions can animate', () => {
    expect(appSource).toContain("{!isSmallScreen && currentView !== 'settings' ? (");
    expect(appSource).toContain("'overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]'");
    expect(appSource).toContain("leftPanelCollapsed ? 'w-0' : 'w-[var(--shell-navigation-width)]'");
  });

  it('lets ModernSidebar behave like a fill-content shell so the outer app column owns the collapse animation', () => {
    expect(sidebarSource).not.toContain("'overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]'");
    expect(sidebarSource).not.toContain("sidebarCollapsed ? 'w-0' : 'w-[var(--shell-navigation-width)]'");
    expect(sidebarSource).toMatch(
      /className="font-sidebar-study-ui[^"]*\bflex\b[^"]*\bh-full\b[^"]*\bmin-h-0\b[^"]*\bw-full\b[^"]*\bmin-w-0\b[^"]*\bflex-col\b[^"]*\boverflow-hidden\b/
    );
  });
});
