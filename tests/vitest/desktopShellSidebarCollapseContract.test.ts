import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop shell sidebar collapse contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

  it('reads the shared left-panel collapsed state when computing desktop shell navigation width', () => {
    expect(appSource).toContain("const leftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);");
    expect(appSource).toContain("const desktopNavigationWidth = !isSmallScreen && currentView !== 'settings' && leftPanelCollapsed ? 0 : shellSidebarWidth;");
    expect(appSource).toContain("'--shell-navigation-width': `${desktopNavigationWidth}px`");
    expect(appSource).toContain('gridTemplateColumns: `${desktopNavigationWidth}px minmax(0, 1fr)`');
  });

  it('declares currentView before using it to compute desktop shell navigation width', () => {
    const currentViewIndex = appSource.indexOf("const [currentView, setCurrentViewRaw] = useState<CurrentView>('chat-v2');");
    const desktopNavigationWidthIndex = appSource.indexOf("const desktopNavigationWidth = !isSmallScreen && currentView !== 'settings' && leftPanelCollapsed ? 0 : shellSidebarWidth;");

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
    expect(appSource).toContain('const desktopFloatingAccessoryWidth = leftPanelCollapsed');
    expect(appSource).toContain("? Math.max(desktopTitlebarLeadingInset - desktopFloatingAccessoryOffset, 0)");
    expect(appSource).toContain(": Math.max(desktopNavigationWidth - desktopFloatingAccessoryOffset - 16, 0);");
    expect(appSource).toContain('const desktopSidebarAccessoryContent = (');
    expect(appSource).toContain('<DesktopSidebarAccessory');
    expect(appSource).toContain('transition-[width,opacity] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none');
    expect(appSource).toContain('width: `${desktopFloatingAccessoryWidth}px`');
    expect(appSource).toContain('opacity: 1,');
    expect(appSource).toContain('pointer-events-auto inline-flex h-full max-w-full items-center justify-between gap-1.5 overflow-hidden pr-1.5');
    expect(appSource).toContain("window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.CHAT_NEW_SESSION));");
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
    expect(sidebarSource).toContain('className="font-sidebar-study-ui relative z-20 flex h-full w-full min-w-0 flex-col');
  });
});
