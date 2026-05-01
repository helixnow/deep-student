import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar icon contract', () => {
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

  it('keeps navigation icon stroke width stable across selected states', () => {
    expect(sidebarSource).toContain('<Icon className="size-[18px]" strokeWidth={2} />');
    expect(sidebarSource).toContain('<StudySettingsIcon className="size-[18px]" strokeWidth={2} />');
    expect(sidebarSource).not.toContain('strokeWidth={isActive ? 2.3 : 2}');
    expect(sidebarSource).not.toContain("strokeWidth={currentView === 'settings' ? 2.3 : 2}");
  });

  it('keeps the conversation-section create action visible with the writing icon', () => {
    const conversationSectionAction = sidebarSource.match(
      /const conversationHeaderAction = \([\s\S]*?<section className="space-y-0\.5 pt-1">/
    )?.[0] ?? '';

    expect(sidebarSource).toContain("import { CommonTooltip } from '@/components/shared/CommonTooltip';");
    expect(sidebarSource).toContain('StudyComposeIcon');
    expect(conversationSectionAction).toContain('<CommonTooltip content={newConversationLabel} position="right">');
    expect(conversationSectionAction).toContain('className="flex shrink-0 items-center gap-1"');
    expect(conversationSectionAction).toContain('<StudyComposeIcon className="w-3.5 h-3.5" />');
    expect(conversationSectionAction).not.toContain('title={newConversationLabel}');
    expect(conversationSectionAction).not.toContain('opacity-0');
    expect(conversationSectionAction).not.toContain('group-hover/sidebar-top-section:opacity-100');
    expect(conversationSectionAction).not.toContain('group-focus-within/sidebar-top-section:opacity-100');
    expect(conversationSectionAction).not.toContain('<Plus className="w-3.5 h-3.5" />');
    expect(conversationSectionAction).not.toContain('<Folder className="size-[16px]" strokeWidth={2} />');
  });

  it('uses CommonTooltip for recent-session archive quick actions', () => {
    const recentSessionRow = sidebarSource.match(
      /const renderRecentSessionRow = useCallback\([\s\S]*?<AppMenuContent align="end" width=\{180\}>/
    )?.[0] ?? '';

    expect(recentSessionRow).toContain('<CommonTooltip content="确认归档会话" position="right">');
    expect(recentSessionRow).toContain('<CommonTooltip content="归档会话" position="right">');
    expect(recentSessionRow).toContain('aria-label="确认归档会话"');
    expect(recentSessionRow).toContain('aria-label="归档会话"');
    expect(recentSessionRow).not.toContain('title="确认归档会话"');
    expect(recentSessionRow).not.toContain('title="归档会话"');
  });

  it('keeps section disclosure arrows after the label and hidden until header hover or focus', () => {
    const sectionHeader = sidebarSource.match(
      /const renderSidebarSectionHeader = \(\{[\s\S]*?const conversationHeaderAction = \(/u
    )?.[0] ?? '';

    const labelIndex = sectionHeader.indexOf('className="desktop-shell-nav-section-label min-w-0 truncate"');
    const arrowIndex = sectionHeader.indexOf('className={cn(');

    expect(labelIndex).toBeGreaterThan(-1);
    expect(arrowIndex).toBeGreaterThan(labelIndex);
    expect(sectionHeader).toContain('opacity-0');
    expect(sectionHeader).toContain('group-hover/sidebar-top-section:opacity-100');
    expect(sectionHeader).toContain('group-focus-within/sidebar-top-section:opacity-100');
    expect(sectionHeader).toMatch(/<ChevronRight[\s\S]*text-\[color:var\(--shell-navigation-section-label\)\]/);
  });
});
