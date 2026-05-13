import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionGroupActions } from '../SessionGroupActions';
import type { SessionGroup } from '../../types/group';

const group: SessionGroup = {
  id: 'group-1',
  name: 'Chemistry',
  description: 'Science group',
  icon: 'flask',
  color: undefined,
  systemPrompt: undefined,
  defaultSkillIds: [],
  pinnedResourceIds: [],
  workspaceId: undefined,
  sortOrder: 0,
  persistStatus: 'active',
  createdAt: '2026-04-06T00:00:00.000Z',
  updatedAt: '2026-04-06T00:00:00.000Z',
};

const labels = {
  groupActions: 'Group actions',
  newSession: 'New session',
  newSessionInGroup: 'New session in {{groupName}}',
  renameGroup: 'Rename group',
  editGroup: 'Edit group',
  archiveGroup: 'Archive group',
};

function renderHarness() {
  const onCreateSession = vi.fn();
  const onRenameGroup = vi.fn();
  const onEditGroup = vi.fn();
  const onArchiveGroup = vi.fn();

  render(
    <SessionGroupActions
      group={group}
      labels={labels}
      onCreateSession={onCreateSession}
      onRenameGroup={onRenameGroup}
      onEditGroup={onEditGroup}
      onArchiveGroup={onArchiveGroup}
    >
      {({ quickAction, onContextMenu }) => (
        <div data-testid="group-header" onContextMenu={onContextMenu}>
          <span>{group.name}</span>
          {quickAction}
        </div>
      )}
    </SessionGroupActions>
  );

  return { onCreateSession, onRenameGroup, onEditGroup, onArchiveGroup };
}

describe('SessionGroupActions', () => {
  it('keeps the ellipsis menu hidden until the group row is hovered/focused, while keeping the new-session icon visible', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/SessionGroupActions.tsx'), 'utf-8');
    const quickAction = source.match(/const quickAction = \([\s\S]*?\n\s*\);/m)?.[0] ?? '';

    // Container itself should no longer be hidden.
    expect(source).toContain('<div className="flex items-center gap-0.5">');
    expect(source).not.toContain('className="flex items-center gap-0.5 opacity-0');

    // Only the menu trigger stays hover/focus/menu-open visible.
    expect(quickAction).toContain('className="opacity-0 transition-opacity duration-150 group-hover/sidebar-section:opacity-100 group-focus-within/sidebar-section:opacity-100 data-[menu-open=true]:opacity-100"');
    expect(quickAction).toMatch(/opacity-0[\s\S]*?<\/div>\s*<CommonTooltip/);
  });

  it('uses the study compose icon for grouped new session quick actions', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/SessionGroupActions.tsx'), 'utf-8');
    const newSessionButton = source.match(
      /aria-label=\{newSessionInGroupLabel\}[\s\S]*?<\/NotionButton>/
    )?.[0] ?? '';
    const sortableGroupItemSource = readFileSync(
      resolve(process.cwd(), 'src/chat-v2/components/SortableGroupItem.tsx'),
      'utf-8'
    );

    expect(source).toContain("import { CommonTooltip } from '@/components/shared/CommonTooltip';");
    expect(source).toContain('const newSessionInGroupLabel = labels.newSessionInGroup.replace(/\\{\\{\\s*groupName\\s*\\}\\}/g, group.name);');
    expect(source).toContain('StudyComposeIcon');
    expect(source).toContain('<CommonTooltip content={newSessionInGroupLabel} position="right">');
    expect(newSessionButton).toContain('<StudyComposeIcon className="w-3.5 h-3.5" />');
    expect(newSessionButton).not.toContain('<Plus className="w-3.5 h-3.5" />');
    expect(newSessionButton).not.toContain('title={labels.newSession}');
    expect(sortableGroupItemSource).toContain("newSessionInGroup: t('page.newSessionInGroup', {");
    expect(sortableGroupItemSource).toContain('groupName: group.name');
    expect(sortableGroupItemSource).toContain("defaultValue: '在 {{groupName}} 中新建会话'");
  });

  it('uses the group-aware new session label for accessibility without native title', () => {
    renderHarness();

    const button = screen.getByRole('button', { name: 'New session in Chemistry' });

    expect(button).toBeInTheDocument();
    expect(button).not.toHaveAttribute('title');
  });

  it('shows the menu items from the ellipsis trigger', async () => {
    renderHarness();

    fireEvent.click(screen.getByRole('button', { name: labels.groupActions }));

    expect(await screen.findByRole('menuitem', { name: labels.renameGroup })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: labels.editGroup })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: labels.archiveGroup })).toBeInTheDocument();
  });

  it('opens the same menu on right click', async () => {
    renderHarness();

    fireEvent.contextMenu(screen.getByTestId('group-header'));

    expect(await screen.findByRole('menuitem', { name: labels.renameGroup })).toBeInTheDocument();
  });

  it('calls the expected callbacks', async () => {
    const { onCreateSession, onRenameGroup, onEditGroup, onArchiveGroup } = renderHarness();

    fireEvent.click(screen.getByRole('button', { name: 'New session in Chemistry' }));
    expect(onCreateSession).toHaveBeenCalledWith(group.id);

    fireEvent.click(screen.getByRole('button', { name: labels.groupActions }));
    fireEvent.click(await screen.findByRole('menuitem', { name: labels.renameGroup }));
    expect(onRenameGroup).toHaveBeenCalledWith(group);

    fireEvent.click(screen.getByRole('button', { name: labels.groupActions }));
    fireEvent.click(await screen.findByRole('menuitem', { name: labels.editGroup }));
    expect(onEditGroup).toHaveBeenCalledWith(group);

    fireEvent.click(screen.getByRole('button', { name: labels.groupActions }));
    fireEvent.click(await screen.findByRole('menuitem', { name: labels.archiveGroup }));
    expect(onArchiveGroup).toHaveBeenCalledWith(group);
  });
});
