import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { repository } = vi.hoisted(() => ({ repository: { list: vi.fn(), changed: () => {} } }));
vi.mock('@/dstu', () => ({ dstu: { list: repository.list, watch: (_: unknown, changed: () => void) => { repository.changed = changed; return () => {}; } } }));
import { NotesLibraryEntry } from '../NotesLibraryView';
afterEach(cleanup);
describe('classic shell notes-only entry', () => {
  it('opens a note from one shared list and updates status/review projections after metadata changes', async () => {
    const note = { id: 'note_a', sourceId: 'note_a', path: '/note_a', name: '数学笔记', type: 'note', createdAt: 1, updatedAt: 1,
      metadata: { props: { study_course: '数学', study_mastery: 'learning', study_review_date: '2020-01-01' } } };
    repository.list.mockResolvedValue({ ok: true, value: [note] });
    const onOpen = vi.fn();
    render(<NotesLibraryEntry onOpen={onOpen}><p>Finder</p></NotesLibraryEntry>);
    fireEvent.click(screen.getByRole('button', { name: '笔记学习' }));
    fireEvent.click(await screen.findByRole('button', { name: /数学笔记/ }));
    expect(onOpen).toHaveBeenCalledWith(note);
    fireEvent.click(screen.getByRole('button', { name: '掌握状态' }));
    expect(screen.getByRole('heading', { name: '学习中 · 1' })).toBeInTheDocument();
    repository.list.mockResolvedValue({ ok: true, value: [{ ...note, updatedAt: 2, metadata: { props: { study_mastery: 'mastered', study_review_date: '2099-01-01' } } }] });
    act(() => repository.changed());
    await screen.findByRole('heading', { name: '已掌握 · 1' });
    fireEvent.click(screen.getByRole('button', { name: '近期复习' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /数学笔记/ })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '新建学习笔记' }));
    expect(screen.getByRole('dialog', { name: '新建学习笔记' })).toBeInTheDocument();
  });
});
