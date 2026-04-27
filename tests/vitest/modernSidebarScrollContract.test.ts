import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar scroll contract', () => {
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

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
    const recentSessionsIndex = sidebarSource.indexOf("aria-label={t('sidebar:aria.recent_sessions', '最近会话')}");

    expect(fixedRegionIndex).toBeGreaterThan(-1);
    expect(scrollAreaIndex).toBeGreaterThan(-1);
    expect(scrollRegionIndex).toBeGreaterThan(scrollAreaIndex);
    expect(primaryNavIndex).toBeGreaterThan(fixedRegionIndex);
    expect(primaryNavIndex).toBeLessThan(scrollAreaIndex);
    expect(pinnedSessionsIndex).toBeGreaterThan(scrollRegionIndex);
    expect(recentSessionsIndex).toBeGreaterThan(scrollRegionIndex);
  });
});
