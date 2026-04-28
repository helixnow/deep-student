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
  it('uses the study compose icon for grouped new session quick actions', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/SessionGroupActions.tsx'), 'utf-8');
    const newSessionButton = source.match(
      /aria-label=\{labels\.newSession\}[\s\S]*?<\/NotionButton>/
    )?.[0] ?? '';

    expect(source).toContain('StudyComposeIcon');
    expect(newSessionButton).toContain('<StudyComposeIcon className="w-3.5 h-3.5" />');
    expect(newSessionButton).not.toContain('<Plus className="w-3.5 h-3.5" />');
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

    fireEvent.click(screen.getByRole('button', { name: labels.newSession }));
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
