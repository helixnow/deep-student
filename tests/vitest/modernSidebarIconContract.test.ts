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

  it('routes topic header actions through CommonTooltip instead of native title tooltips', () => {
    const topicSectionAction = sidebarSource.match(
      /<section className="space-y-0\.5 pt-1">\s*\{renderSidebarSectionHeader\(\{[\s\S]*?\}\)\}\s*\{!isTopicsSectionCollapsed/u
    )?.[0] ?? '';

    expect(topicSectionAction).toContain('<CommonTooltip content={toggleAllTopicsLabel} position="right">');
    expect(topicSectionAction).toContain('<CommonTooltip content={createTopicLabel} position="right">');
    expect(topicSectionAction).toContain('aria-label={toggleAllTopicsLabel}');
    expect(topicSectionAction).toContain('aria-label={createTopicLabel}');
    expect(topicSectionAction).not.toContain("title={areAllTopicGroupsExpanded");
    expect(topicSectionAction).not.toContain("title={t('sidebar:actions.create_topic', '新建课题')}");
  });

  it('uses CommonTooltip and icon swap for recent-session archive quick actions', () => {
    const recentSessionRow = sidebarSource.match(
      /const renderRecentSessionRow = useCallback\([\s\S]*?<AppMenuContent align="end" width=\{180\}>/
    )?.[0] ?? '';

    expect(recentSessionRow).toContain("<CommonTooltip content={isConfirmingArchive ? '确认归档会话' : '归档会话'} position=\"right\">");
    expect(recentSessionRow).toContain("aria-label={isConfirmingArchive ? '确认归档会话' : '归档会话'}");
    expect(recentSessionRow).toContain('className="t-icon-swap h-3.5 w-3.5"');
    expect(recentSessionRow).toContain("data-state={isConfirmingArchive ? 'b' : 'a'}");
    expect(recentSessionRow).toContain('<Archive className="h-3.5 w-3.5" />');
    expect(recentSessionRow).toContain('<Check className="h-3.5 w-3.5" />');
    expect(recentSessionRow).not.toContain('title="确认归档会话"');
    expect(recentSessionRow).not.toContain('title="归档会话"');
  });

  it('keeps the transitions-dev icon swap CSS hook installed globally', () => {
    const transitionSource = readFileSync(resolve(process.cwd(), 'src/styles/transitions-dev.css'), 'utf-8');

    expect(transitionSource).toContain('--icon-swap-dur: 200ms;');
    expect(transitionSource).toContain('.t-icon-swap .t-icon');
    expect(transitionSource).toContain('.t-icon-swap[data-state="a"] .t-icon[data-icon="a"]');
    expect(transitionSource).toContain('.t-icon-swap[data-state="b"] .t-icon[data-icon="a"]');
    expect(transitionSource).toContain('@media (prefers-reduced-motion: reduce)');
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
