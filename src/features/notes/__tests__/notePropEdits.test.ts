import { describe, expect, it } from 'vitest';
import { mergeNotePropEdits } from '../notePropEdits';

describe('fresh metadata edit merge', () => {
  it('applies explicit edits and removals while preserving concurrently changed legacy scalars', () => {
    const baseline = { course: '旧自由字段', due: 'friday', count: 1, checked: false };
    const edited = { course: '旧自由字段', count: 1, checked: false, study_course: '数学' };
    const latest = { ...baseline, count: 2, checked: true, added: '另一个窗口' };
    expect(mergeNotePropEdits(baseline, edited, latest)).toEqual({
      course: '旧自由字段', count: 2, checked: true, added: '另一个窗口', study_course: '数学',
    });
    expect(latest.due).toBe('friday');
  });

  it('rejects deleting a concurrently edited key, but accepts an already persisted retry', () => {
    expect(() => mergeNotePropEdits({ due: 'friday' }, {}, { due: 'monday' })).toThrow('已在其他位置修改');
    expect(mergeNotePropEdits({ study_course: '旧课程' }, { study_course: '数学' }, { study_course: '数学', score: 8 }))
      .toEqual({ study_course: '数学', score: 8 });
  });
});
