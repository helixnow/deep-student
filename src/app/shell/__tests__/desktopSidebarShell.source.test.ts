import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const shellCssSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf8');

describe('desktop sidebar shell wiring', () => {
  it('slides an intact sidebar surface while its layout track closes', () => {
    expect(appSource).toContain("'--shell-sidebar-translate-x': `${desktopSidebarTranslateX}px`");
    expect(appSource).toContain('className="desktop-shell-sidebar-track t-resize"');
    expect(appSource).toContain('className="desktop-shell-sidebar-motion-surface"');
    expect(appSource).not.toContain('className="desktop-shell-sidebar-titlebar-surface"');
    expect(appSource).toContain("'--shell-navigation-surface-width'");
    expect(appSource).toContain('setDesktopSidebarMotionWidth(leftPanelCollapsed ? null : shellSidebarWidth)');
    expect(shellCssSource).toContain('var(--shell-navigation-surface-width, var(--shell-navigation-width))');
    expect(appSource).toContain('<DesktopSidebarResizeHandle');
  });

  it('keeps top controls mounted at one fixed titlebar anchor', () => {
    expect(appSource).toContain('const desktopSidebarTopAccessoryContent = (');
    expect(appSource).toContain('className="desktop-shell-sidebar-top-accessory"');
    expect(appSource).toContain('className="desktop-shell-sidebar-top-accessory"\n                data-no-drag');
    expect(shellCssSource).toContain('.desktop-shell-sidebar-top-accessory {\n  /* Keep titlebar controls out of the sidebar\'s animated layout layer. */\n  position: fixed;');
    expect(shellCssSource).toContain('transition: none !important;');
    expect(shellCssSource).not.toContain('.desktop-shell-sidebar-collapsed-accessory');
  });

  it('shows the new-session action only when the left sidebar is collapsed', () => {
    expect(appSource).toContain('<StudyComposeIcon className="h-4 w-4" />');
    expect(appSource).toContain('showNewSession={leftPanelCollapsed}');
    expect(appSource).toContain('{showNewSession ? (');
    expect(appSource).not.toContain('isDesktopFullscreen');
  });

  it('keeps macOS custom chrome in the native titlebar row', () => {
    expect(appSource).toContain('isSmallScreen || isMacOS() ? 0 : topbarTopMargin');
    expect(appSource).toContain('top: `${shellTitlebarTopInset}px`');
    expect(appSource).toContain('height: `${shellTitlebarOccupiedHeight}px`');
    expect(shellCssSource).toContain('min-height: var(--shell-titlebar-content-height, 40px);');
  });

  it('uses one motion rhythm and disables it during live resizing', () => {
    expect(shellCssSource).toContain('.t-resize');
    expect(shellCssSource).toContain('transform var(--resize-dur) var(--resize-ease)');
    expect(shellCssSource).toContain('[data-sidebar-resizing="true"]');
    expect(shellCssSource).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('re-enables motion before a threshold crossing starts the close animation', () => {
    expect(appSource).toContain('requestedWidth <= DESKTOP_SHELL.navigationCloseSnapWidth');
    expect(appSource).toContain('const [desktopSidebarMotionWidth, setDesktopSidebarMotionWidth]');
    expect(appSource).toContain('desktopSidebarMotionWidth ?? shellSidebarWidth');
    expect(appSource).toContain('setDesktopSidebarMotionWidth(DESKTOP_SHELL.navigationMinWidth)');
    expect(appSource).toContain("'--shell-navigation-width'");
    expect(appSource).toContain('`${DESKTOP_SHELL.navigationMinWidth}px`');
    expect(appSource).toContain('setIsDesktopSidebarResizing(false);\n      requestAnimationFrame(() => {');
    expect(appSource).toContain('leftPanelCollapsed: true,');
  });

  it('uses a centered invisible hit area with a compact resize affordance', () => {
    expect(shellCssSource).toContain('left: calc(var(--shell-navigation-width) - 6px);');
    expect(shellCssSource).toContain('width: 12px;');
    expect(shellCssSource).toContain('top: 50%;');
    expect(shellCssSource).toContain('height: 40px;');
    expect(shellCssSource).toContain('border-radius: 999px;');
    expect(shellCssSource).toContain('translate(-50%, -50%) scaleY(0.72)');
    expect(shellCssSource).toContain('translate(-50%, -50%) scaleY(1)');
  });
});
