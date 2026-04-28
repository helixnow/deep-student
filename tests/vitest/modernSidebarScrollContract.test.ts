import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar scroll contract', () => {
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
  const appCss = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');

  it('keeps primary workspace navigation fixed while only session groups scroll', () => {
    expect(sidebarSource).toContain('data-sidebar-fixed-region="primary-navigation"');
    expect(sidebarSource).toContain('data-sidebar-scroll-region');
    expect(sidebarSource).toContain("'sessions'");
    expect(sidebarSource).toMatch(
      /className="font-sidebar-study-ui[^"]*\bmin-h-0\b[^"]*\boverflow-hidden\b/
    );
    expect(sidebarSource).toContain('viewportProps={{');

    const fixedRegionIndex = sidebarSource.indexOf('data-sidebar-fixed-region="primary-navigation"');
    const scrollAreaIndex = sidebarSource.indexOf('<CustomScrollArea');
    const scrollRegionIndex = sidebarSource.indexOf('data-sidebar-scroll-region');
    const primaryNavIndex = sidebarSource.indexOf("aria-label={t('sidebar:aria.workspace_primary_entry', '工作区主入口')}");
    const pinnedSessionsIndex = sidebarSource.indexOf("aria-label={t('sidebar:aria.pinned_sessions', '置顶会话')}");
    const topicSessionsIndex = sidebarSource.indexOf("aria-label={t('sidebar:aria.topic_sessions', '课题')}");
    const conversationSessionsIndex = sidebarSource.indexOf("aria-label={t('sidebar:aria.conversation_sessions', '对话')}");

    expect(fixedRegionIndex).toBeGreaterThan(-1);
    expect(scrollAreaIndex).toBeGreaterThan(-1);
    expect(scrollRegionIndex).toBeGreaterThan(scrollAreaIndex);
    expect(primaryNavIndex).toBeGreaterThan(fixedRegionIndex);
    expect(primaryNavIndex).toBeLessThan(scrollAreaIndex);
    expect(pinnedSessionsIndex).toBeGreaterThan(scrollRegionIndex);
    expect(topicSessionsIndex).toBeGreaterThan(scrollRegionIndex);
    expect(conversationSessionsIndex).toBeGreaterThan(scrollRegionIndex);
  });

  it('adds only a bottom soft edge fade to the session scroll region without blocking interactions', () => {
    const fadeCss = appCss.slice(
      appCss.indexOf('.desktop-shell-sidebar-session-scroll'),
      appCss.indexOf('.desktop-shell-header-title')
    );

    expect(sidebarSource).toContain('desktop-shell-sidebar-session-scroll');
    expect(fadeCss).not.toContain('.desktop-shell-sidebar-session-scroll::before');
    expect(fadeCss).toContain('.desktop-shell-sidebar-session-scroll::after');
    expect(fadeCss).toContain('pointer-events: none');
    expect(fadeCss).toContain('var(--shell-navigation-surface)');
  });

  it('keeps the session edge fade compatible with desktop WebViews', () => {
    const fadeCss = appCss.slice(
      appCss.indexOf('.desktop-shell-sidebar-session-scroll'),
      appCss.indexOf('.desktop-shell-header-title')
    );

    expect(fadeCss).not.toContain('color-mix');
    expect(fadeCss).toContain('display: block');
    expect(fadeCss).toContain('--desktop-shell-sidebar-session-fade-size: 36px');
  });

  it('applies the bottom edge fade directly to the session scroll viewport content', () => {
    const fadeCss = appCss.slice(
      appCss.indexOf('.desktop-shell-sidebar-session-scroll'),
      appCss.indexOf('.desktop-shell-header-title')
    );

    expect(sidebarSource).toContain('desktop-shell-sidebar-session-scroll-viewport');
    expect(fadeCss).toContain('.desktop-shell-sidebar-session-scroll-viewport');
    expect(fadeCss).toContain('-webkit-mask-image');
    expect(fadeCss).toContain('mask-image');
    expect(fadeCss).toContain('#000 0');
    expect(fadeCss).toContain('#000 calc(100% - var(--desktop-shell-sidebar-session-fade-size))');
    expect(fadeCss).not.toContain('transparent 0');
  });
});
