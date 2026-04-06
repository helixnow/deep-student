import { fireEvent, render, screen } from '@testing-library/react';
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
  renameGroup: 'Rename group',
  editGroup: 'Edit group',
  deleteGroup: 'Delete group',
};

function renderHarness() {
  const onCreateSession = vi.fn();
  const onRenameGroup = vi.fn();
  const onEditGroup = vi.fn();
  const onDeleteGroup = vi.fn();

  render(
    <SessionGroupActions
      group={group}
      labels={labels}
      onCreateSession={onCreateSession}
      onRenameGroup={onRenameGroup}
      onEditGroup={onEditGroup}
      onDeleteGroup={onDeleteGroup}
    >
      {({ quickAction, onContextMenu }) => (
        <div data-testid="group-header" onContextMenu={onContextMenu}>
          <span>{group.name}</span>
          {quickAction}
        </div>
      )}
    </SessionGroupActions>
  );

  return { onCreateSession, onRenameGroup, onEditGroup, onDeleteGroup };
}

describe('SessionGroupActions', () => {
  it('shows the menu items from the ellipsis trigger', async () => {
    renderHarness();

    fireEvent.click(screen.getByRole('button', { name: labels.groupActions }));

    expect(await screen.findByRole('menuitem', { name: labels.renameGroup })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: labels.editGroup })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: labels.deleteGroup })).toBeInTheDocument();
  });

  it('opens the same menu on right click', async () => {
    renderHarness();

    fireEvent.contextMenu(screen.getByTestId('group-header'));

    expect(await screen.findByRole('menuitem', { name: labels.renameGroup })).toBeInTheDocument();
  });

  it('calls the expected callbacks', async () => {
    const { onCreateSession, onRenameGroup, onEditGroup, onDeleteGroup } = renderHarness();

    fireEvent.click(screen.getByRole('button', { name: labels.newSession }));
    expect(onCreateSession).toHaveBeenCalledWith(group.id);

    fireEvent.click(screen.getByRole('button', { name: labels.groupActions }));
    fireEvent.click(await screen.findByRole('menuitem', { name: labels.renameGroup }));
    expect(onRenameGroup).toHaveBeenCalledWith(group);

    fireEvent.click(screen.getByRole('button', { name: labels.groupActions }));
    fireEvent.click(await screen.findByRole('menuitem', { name: labels.editGroup }));
    expect(onEditGroup).toHaveBeenCalledWith(group);

    fireEvent.click(screen.getByRole('button', { name: labels.groupActions }));
    fireEvent.click(await screen.findByRole('menuitem', { name: labels.deleteGroup }));
    expect(onDeleteGroup).toHaveBeenCalledWith(group);
  });
});
