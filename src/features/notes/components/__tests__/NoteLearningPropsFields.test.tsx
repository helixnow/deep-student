import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoteLearningPropsFields } from '../NoteLearningPropsFields';

describe('learning property drafts', () => {
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
