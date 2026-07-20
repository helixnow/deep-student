import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { listTrash, restoreItem, permanentlyDelete, emptyTrash } = vi.hoisted(() => ({
  listTrash: vi.fn(),
  restoreItem: vi.fn(),
  permanentlyDelete: vi.fn(),
  emptyTrash: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  trashApi: {
    listTrash,
    restoreItem,
    permanentlyDelete,
    emptyTrash,
  },
}));

import { NotesTrashDialog } from '../NotesTrashDialog';

function node(overrides: Partial<DstuNode> = {}): DstuNode {
  return {
    id: 'note_1',
    sourceId: 'note_1',
    path: '/_trash/note_1',
    name: 'Draft note',
    type: 'note',
    createdAt: 1_000,
    updatedAt: 3_000,
    ...overrides,
  };
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof NotesTrashDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const result = render(
    <NotesTrashDialog
      open
      onOpenChange={onOpenChange}
      onChanged={onChanged}
      {...overrides}
    />,
  );
  return { onOpenChange, onChanged, ...result };
}

describe('NotesTrashDialog', () => {
  beforeEach(() => {
    listTrash.mockReset();
    restoreItem.mockReset();
    permanentlyDelete.mockReset();
    emptyTrash.mockReset();
    listTrash.mockResolvedValue({ ok: true, value: [] });
    restoreItem.mockResolvedValue({ ok: true, value: undefined });
    permanentlyDelete.mockResolvedValue({ ok: true, value: undefined });
    emptyTrash.mockResolvedValue({ ok: true, value: 0 });
  });

  it('loads note + mindmap + folder items sorted by deleted time desc', async () => {
    listTrash.mockResolvedValueOnce({
      ok: true,
      value: [
        node({ id: 'note_old', name: 'Old', updatedAt: 100 }),
        node({
          id: 'mindmap_new',
          sourceId: 'mindmap_new',
          path: '/_trash/mindmap_new',
          name: 'Map',
          type: 'mindmap',
          updatedAt: 500,
        }),
        node({
          id: 'fld_mid',
          sourceId: 'fld_mid',
          path: '/_trash/fld_mid',
          name: 'Folder',
          type: 'folder',
          updatedAt: 300,
        }),
        node({
          id: 'essay_skip',
          sourceId: 'essay_skip',
          path: '/_trash/essay_skip',
          name: 'Essay',
          type: 'essay',
          updatedAt: 900,
        }),
      ],
    });

    renderDialog();

    const panel = await screen.findByRole('region', { name: /回收站|Trash/i });
    await waitFor(() => expect(listTrash).toHaveBeenCalled());

    const names = within(panel).getAllByText(/Old|Map|Folder|Essay/).map((el) => el.textContent);
    expect(names).toEqual(['Map', 'Folder', 'Old']);
  });

  it('restores an item and notifies the host', async () => {
    listTrash.mockResolvedValueOnce({
      ok: true,
      value: [node()],
    });
    const { onChanged } = renderDialog();

    const restore = await screen.findByRole('button', { name: /恢复 Draft note|Restore Draft note/i });
    fireEvent.click(restore);

    await waitFor(() => expect(restoreItem).toHaveBeenCalledWith('note_1', 'note'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByText('Draft note')).toBeNull();
  });

  it('permanently deletes after confirm', async () => {
    listTrash.mockResolvedValueOnce({
      ok: true,
      value: [node()],
    });
    const { onChanged } = renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: /彻底删除 Draft note|Delete Draft note permanently/i }));
    const confirm = await screen.findByRole('group', { name: /彻底删除|Delete permanently/i });
    fireEvent.click(within(confirm).getByRole('button', { name: /彻底删除|Delete permanently/i }));

    await waitFor(() => expect(permanentlyDelete).toHaveBeenCalledWith('note_1', 'note'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('empties the trash after confirm and shows count', async () => {
    listTrash.mockResolvedValueOnce({
      ok: true,
      value: [
        node(),
        node({
          id: 'mindmap_2',
          sourceId: 'mindmap_2',
          path: '/_trash/mindmap_2',
          name: 'Map',
          type: 'mindmap',
          updatedAt: 4_000,
        }),
      ],
    });
    const { onChanged } = renderDialog();

    const emptyBtn = await screen.findByRole('button', { name: /清空回收站（2）|Empty trash \(2\)/i });
    fireEvent.click(emptyBtn);
    const confirm = await screen.findByRole('group', { name: /清空回收站|Empty trash/i });
    expect(confirm).toHaveTextContent(/2/);
    fireEvent.click(within(confirm).getByRole('button', { name: /^清空$|^Empty$/i }));

    await waitFor(() => expect(emptyTrash).toHaveBeenCalled());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText(/回收站为空|Trash is empty/i)).toBeInTheDocument();
  });

  it('closes on Escape and traps Tab focus', async () => {
    listTrash.mockResolvedValueOnce({ ok: true, value: [node()] });
    const { onOpenChange } = renderDialog();

    const dialog = await screen.findByRole('dialog', { name: /回收站|Trash/i });
    await waitFor(() => expect(listTrash).toHaveBeenCalled());

    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(1);
    buttons[0].focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true, bubbles: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows empty state when trash has no workspace items', async () => {
    listTrash.mockResolvedValueOnce({ ok: true, value: [] });
    renderDialog();
    expect(await screen.findByText(/回收站为空|Trash is empty/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <NotesTrashDialog open={false} onOpenChange={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(listTrash).not.toHaveBeenCalled();
  });

  it('surfaces load errors with retry', async () => {
    listTrash
      .mockResolvedValueOnce({
        ok: false,
        error: { toUserMessage: () => 'boom' },
      })
      .mockResolvedValueOnce({ ok: true, value: [] });

    renderDialog();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/i }));
    await waitFor(() => expect(listTrash).toHaveBeenCalledTimes(2));
  });
});
