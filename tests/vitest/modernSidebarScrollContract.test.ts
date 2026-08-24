import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar scroll contract', () => {
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
  const primitiveSource = readFileSync(resolve(process.cwd(), 'src/features/workbench/components/sidebar/WorkbenchSidebar.tsx'), 'utf-8');
  const appCss = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');

  it('keeps primary workspace navigation fixed while only session groups scroll', () => {
    expect(sidebarSource).toContain('data-sidebar-fixed-region="primary-navigation"');
    expect(sidebarSource).toContain('<WorkbenchSidebarFixed');
    expect(sidebarSource).toContain('<WorkbenchSidebarScroll>');
    expect(sidebarSource.indexOf('<WorkbenchSidebarFixed')).toBeLessThan(sidebarSource.indexOf('<WorkbenchSidebarScroll>'));
    expect(primitiveSource).toContain('data-sidebar-scroll-region');
    expect(primitiveSource).toContain("'sessions'");
    expect(primitiveSource).toContain('<CustomScrollArea');
  });

  it('does not overlay session fades that could block pointer events', () => {
    expect(primitiveSource).toContain('desktop-shell-sidebar-session-scroll');
    expect(appCss).not.toContain('.desktop-shell-sidebar-session-scroll::before');
    expect(appCss).not.toContain('.desktop-shell-sidebar-session-scroll::after');
  });

  it('does not apply a session fade mask to the OverlayScrollbars viewport', () => {
    expect(primitiveSource).not.toContain('desktop-shell-sidebar-session-scroll-viewport');
    expect(appCss).not.toContain('.desktop-shell-sidebar-session-scroll-viewport {');
  });

  it('keeps session scrolling on CustomScrollArea without a dedicated fade token', () => {
    expect(primitiveSource).toContain('scrollAutoHide="scroll"');
    expect(appCss).not.toContain('--desktop-shell-sidebar-session-fade-size');
  });
});
