import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar icon contract', () => {
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
  const workbenchSidebarSource = readFileSync(resolve(process.cwd(), 'src/features/workbench/components/sidebar/WorkbenchSidebar.tsx'), 'utf-8');

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
    expect(conversationSectionAction).toContain('<CommonTooltip content={newConversationLabel} position="right" shortcut={formatShortcut(\'mod+n\')}>');
    expect(conversationSectionAction).toContain('data-sidebar-section-action="create-conversation"');
    expect(conversationSectionAction).toContain('ml-auto flex shrink-0 items-center gap-1 text-[color:var(--shell-navigation-foreground)]');
    expect(conversationSectionAction).toContain('<StudyComposeIcon className="w-3.5 h-3.5" />');
    expect(conversationSectionAction).toContain('hover:bg-transparent');
    expect(conversationSectionAction).toContain('hover:text-[color:var(--shell-navigation-foreground)]');
    expect(conversationSectionAction).toContain('active:bg-transparent');
    expect(conversationSectionAction).toContain('!rounded-none');
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
    const recentSessionRowStart = sidebarSource.indexOf('const renderRecentSessionRow = useCallback');
    const recentSessionRowEnd = sidebarSource.indexOf('const pinnedRecentSessions', recentSessionRowStart);
    const recentSessionRow = sidebarSource.slice(recentSessionRowStart, recentSessionRowEnd);

    expect(recentSessionRowStart).toBeGreaterThanOrEqual(0);
    expect(recentSessionRowEnd).toBeGreaterThan(recentSessionRowStart);
    expect(recentSessionRow).toContain("content={isConfirmingArchive ? t('sidebar:aria.confirm_archive_session') : t('sidebar:aria.archive_session')}");
    expect(recentSessionRow).toContain("aria-label={isConfirmingArchive ? t('sidebar:aria.confirm_archive_session') : t('sidebar:aria.archive_session')}");
    expect(recentSessionRow).toContain('className="w-3.5 h-3.5 t-icon-swap"');
    expect(recentSessionRow).toContain("data-state={isConfirmingArchive ? 'b' : 'a'}");
    expect(recentSessionRow).toContain('<Archive size={14} />');
    expect(recentSessionRow).toContain('<Check size={14} />');
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

  it('keeps section disclosure arrows visible only while a section is collapsed', () => {
    const sectionHeaderStart = workbenchSidebarSource.indexOf('export function WorkbenchSidebarSectionHeader');
    const sectionHeaderEnd = workbenchSidebarSource.length;
    const sectionHeader = sectionHeaderStart >= 0
      ? workbenchSidebarSource.slice(sectionHeaderStart, sectionHeaderEnd)
      : '';

    const labelIndex = sectionHeader.indexOf('className="desktop-shell-nav-section-label desktop-shell-sidebar-section-label min-w-0 truncate"');
    const arrowIndex = sectionHeader.indexOf('className={cn(');

    expect(labelIndex).toBeGreaterThan(-1);
    expect(arrowIndex).toBeGreaterThan(labelIndex);
    expect(sectionHeader).toContain("collapsed ? 'rotate-0 opacity-100' : 'rotate-90 opacity-0 group-hover/sidebar-top-section:opacity-100'");
    expect(sectionHeader).not.toContain('group-focus-within/sidebar-top-section:opacity-100');
    expect(sectionHeader).toContain('text-[color:var(--shell-navigation-muted)]');
    expect(sectionHeader).toContain('hover:bg-transparent');
    expect(sectionHeader).toContain('hover:text-[color:var(--shell-navigation-muted)]');
  });
});
