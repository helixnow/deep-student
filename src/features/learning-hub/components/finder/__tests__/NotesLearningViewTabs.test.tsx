import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesLearningViewTabs, useNotesLearningView } from '../NotesLearningViewTabs';
import { NoteLearningViews } from '@/features/notes/components/NoteLearningViews';
import type { DstuNode } from '@/dstu';

vi.mock('@/utils/notesApi', () => ({ NotesAPI: { getPref: vi.fn().mockResolvedValue(null), setPref: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => localStorage.clear());

const note = (id: string, name: string, props: Record<string, string>) => ({
  id, sourceId: id, path: `/${id}`, name, type: 'note', createdAt: 1, updatedAt: 1, metadata: { props },
}) as unknown as DstuNode;

function Host({ notes, onOpen }: { notes: DstuNode[]; onOpen: (note: DstuNode) => void }) {
  const [view, setView] = useNotesLearningView();
  return <>
    <NotesLearningViewTabs value={view} onChange={setView} />
    {view === 'list' ? <p>Finder list</p> : <NoteLearningViews notes={notes} view={view} onOpen={onOpen} now={new Date('2026-10-01T12:00:00')} />}
  </>;
}

describe('Finder notes learning views', () => {
  it('switches projections of the same list, shows chips, remembers the view and opens notes', () => {
    const onOpen = vi.fn();
    const notes = [note('a', '微积分', { study_course: '高数', study_mastery: 'learning', study_review_date: '2026-09-20' }),
      note('b', '英语', { study_mastery: 'mastered' })];
    const view = render(<Host notes={notes} onOpen={onOpen} />);
    expect(screen.getByRole('tab', { name: '全部' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Finder list')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '掌握状态' }));
    expect(screen.getByRole('heading', { name: '学习中 · 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '已掌握 · 1' })).toBeInTheDocument();
    expect(screen.getByText('高数')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '近期复习' }));
    expect(screen.getByText(/2026-09-20 · /)).toHaveAttribute('data-due', 'overdue');
    fireEvent.click(screen.getByRole('button', { name: /微积分/ }));
    expect(onOpen).toHaveBeenCalledWith(notes[0]);
    view.unmount();
    render(<Host notes={notes} onOpen={onOpen} />);
    expect(screen.getByRole('tab', { name: '近期复习' })).toHaveAttribute('aria-selected', 'true');
  });
});
