import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyLearningPropsMapper } from '../LegacyLearningPropsMapper';
import { applyLearningPropMapping, previewLearningPropMapping, undoLearningPropMapping } from '../../noteLearningProps';

afterEach(cleanup);
describe('explicit legacy mapping', () => {
  it('previews, applies and undoes only selected target keys; unknown values survive', async () => {
    let value: Record<string, unknown> = { oldCourse: '数学', unknown: { custom: 7 }, study_course: '历史' };
    const save = vi.fn(async (next) => { value = next; view.rerender(<LegacyLearningPropsMapper value={value} onSave={save} />); return true; });
    const view = render(<LegacyLearningPropsMapper value={value} onSave={save} />);
    fireEvent.click(screen.getByText('映射旧自由属性'));
    fireEvent.change(screen.getByLabelText('课程来源属性'), { target: { value: 'oldCourse' } });
    fireEvent.click(screen.getByRole('button', { name: '预览映射' }));
    await screen.findByText(/历史 → 数学/);
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用映射' }));
    await screen.findByRole('button', { name: '撤销上次映射' });
    expect(value).toEqual({ oldCourse: '数学', unknown: { custom: 7 }, study_course: '数学' });
    value = { ...value, later: '新增' };
    view.rerender(<LegacyLearningPropsMapper value={value} onSave={save} />);
    fireEvent.click(screen.getByRole('button', { name: '撤销上次映射' }));
    await waitFor(() => expect(value.study_course).toBe('历史'));
    expect(value.later).toBe('新增');
  });
  it('retains the preview after save failure and rejects changed source/target or unsafe undo', async () => {
    const before = { oldCourse: '数学' };
    const preview = previewLearningPropMapping(before, [{ sourceKey: 'oldCourse', field: 'course', value: '数学' }]);
    expect(() => applyLearningPropMapping({ oldCourse: '物理' }, preview)).toThrow();
    expect(() => applyLearningPropMapping({ ...before, study_course: '物理' }, preview)).toThrow();
    expect(() => undoLearningPropMapping({ ...before, study_course: '后来修改' }, preview)).toThrow();
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    render(<LegacyLearningPropsMapper value={before} onSave={save} />);
    fireEvent.click(screen.getByText('映射旧自由属性'));
    fireEvent.change(screen.getByLabelText('课程来源属性'), { target: { value: 'oldCourse' } });
    fireEvent.click(screen.getByRole('button', { name: '预览映射' }));
    fireEvent.click(await screen.findByRole('button', { name: '应用映射' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    expect(screen.getByRole('button', { name: '应用映射' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '撤销上次映射' })).toBeNull();
  });
});
