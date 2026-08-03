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

  it('uses a viewport mask fade instead of overlay pseudo-elements that could block interactions', () => {
    const fadeCss = appCss.slice(
      appCss.indexOf('.desktop-shell-sidebar-session-scroll'),
      appCss.indexOf('.desktop-shell-header-title')
    );

    expect(primitiveSource).toContain('desktop-shell-sidebar-session-scroll');
    expect(fadeCss).not.toContain('.desktop-shell-sidebar-session-scroll::before');
    expect(fadeCss).not.toContain('.desktop-shell-sidebar-session-scroll::after');
    expect(fadeCss).toContain('.desktop-shell-sidebar-session-scroll-viewport');
    expect(fadeCss).toContain('mask-image');
  });

  it('keeps the session edge fade compatible with desktop WebViews', () => {
    const fadeCss = appCss.slice(
      appCss.indexOf('.desktop-shell-sidebar-session-scroll'),
      appCss.indexOf('.desktop-shell-header-title')
    );

    expect(fadeCss).not.toContain('color-mix');
    expect(fadeCss).toContain('--desktop-shell-sidebar-session-fade-size: 28px');
    expect(fadeCss).toContain('-webkit-mask-image');
  });

  it('applies the bottom edge fade directly to the session scroll viewport content', () => {
    const fadeCss = appCss.slice(
      appCss.indexOf('.desktop-shell-sidebar-session-scroll'),
      appCss.indexOf('.desktop-shell-header-title')
    );

    expect(primitiveSource).toContain('desktop-shell-sidebar-session-scroll-viewport');
    expect(fadeCss).toContain('.desktop-shell-sidebar-session-scroll-viewport');
    expect(fadeCss).toContain('-webkit-mask-image');
    expect(fadeCss).toContain('mask-image');
    expect(fadeCss).toContain('transparent 0%');
    expect(fadeCss).toContain('black var(--desktop-shell-sidebar-session-fade-size)');
    expect(fadeCss).toContain('black calc(100% - var(--desktop-shell-sidebar-session-fade-size))');
  });
});
