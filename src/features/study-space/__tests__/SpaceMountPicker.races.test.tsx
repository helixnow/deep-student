import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceMountPickerDialog } from '../components/SpaceMountPickerDialog';
import { useStudySpaceStore } from '../store/studySpaceStore';
import { STUDY_SPACE_IPC_COMMANDS } from '../types';

const { invoke, notify } = vi.hoisted(() => ({ invoke: vi.fn(), notify: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notify }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/dstu', () => ({ dstu: { list: vi.fn(async () => ({ ok: true, value: [] })) } }));

describe('Space mount picker submission', () => {
  beforeEach(() => {
    invoke.mockReset();
    notify.mockReset();
    useStudySpaceStore.getState().resetForTests();
    useStudySpaceStore.getState().upsertGroupInState({
      id: 'grp_target', name: 'Target', rootFolderId: 'fld_target', defaultSkillIds: [],
      pinnedResourceIds: [], sortOrder: 0, persistStatus: 'active', createdAt: '2026-11-11', updatedAt: '2026-11-11',
    });
  });

  it('formats a structured ancestor/cycle error without closing or reporting success', async () => {
    invoke.mockRejectedValue({ code: 'VALIDATION_ERROR', message: 'Cannot mount an ancestor inside its descendant' });
    const onOpenChange = vi.fn();
    render(<SpaceMountPickerDialog open onOpenChange={onOpenChange} item={{ itemId: 'fld_ancestor', itemType: 'folder', title: 'Ancestor' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'chatV2:studySpace.mounts.add' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'Cannot mount an ancestor inside its descendant'));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(useStudySpaceStore.getState().mountsBySpaceId.grp_target).toEqual([]);
  });

  it('submits only one mount for rapid repeated confirmation', async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const onOpenChange = vi.fn();
    render(<SpaceMountPickerDialog open onOpenChange={onOpenChange} item={{ itemId: 'note_once', itemType: 'note', title: 'Once' }} />);
    const confirm = await screen.findByRole('button', { name: 'chatV2:studySpace.mounts.add' });
    act(() => { confirm.click(); confirm.click(); });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(STUDY_SPACE_IPC_COMMANDS.addMount, { input: { spaceId: 'grp_target', targetFolderId: 'fld_target', itemType: 'note', itemId: 'note_once' } });
    await act(async () => resolve({ id: 'mnt_once', spaceId: 'grp_target', targetFolderId: 'fld_target', itemType: 'note', itemId: 'note_once', createdAt: '2026-11-11' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
