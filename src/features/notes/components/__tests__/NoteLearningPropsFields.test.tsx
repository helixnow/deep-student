import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoteLearningPropsFields } from '../NoteLearningPropsFields';

describe('learning property drafts', () => {
  it('rejects a same-field update while retaining the draft for explicit reconciliation', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { rerender, unmount } = render(<NoteLearningPropsFields value={{ study_course: 'old' }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: 'my draft' } });
    rerender(<NoteLearningPropsFields value={{ study_course: 'concurrent' }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await screen.findByRole('alert');
    expect(onSave).not.toHaveBeenCalled(); expect(screen.getByLabelText('课程')).toHaveValue('my draft');
    fireEvent.click(screen.getByRole('button', { name: '已核对最新值，保留草稿重试' }));
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ study_course: 'my draft' }));
    unmount();
  });
  it('keeps an in-progress field across metadata refreshes and merges only that field into the new baseline', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { rerender } = render(<NoteLearningPropsFields key="a" value={{ status: 'draft' }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: '正在填写' } });
    rerender(<NoteLearningPropsFields key="a" value={{ status: 'done', study_review_date: '2026-09-22' }} onSave={onSave} />);
    expect(screen.getByLabelText('课程')).toHaveValue('正在填写');
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      status: 'done', study_course: '正在填写', study_review_date: '2026-09-22',
    }));
    rerender(<NoteLearningPropsFields key="b" value={{ study_course: '另一篇课程' }} onSave={onSave} />);
    expect(screen.getByLabelText('课程')).toHaveValue('另一篇课程');
  });
});
