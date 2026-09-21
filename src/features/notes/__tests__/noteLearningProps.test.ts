import { describe, expect, it } from 'vitest';
import {
  isCalendarDate, readNoteLearningProps, updateNoteLearningProps, selectLearningViewNotes, sameNoteLearningMetadata,
} from '../noteLearningProps';

describe('typed learning properties', () => {
  it('keeps legacy scalars and invalid typed values unchanged when another field is edited', () => {
    const legacy = { course: '旧课程', status: 'done', due: '明天', score: 90, pinned: true, study_mastery: '旧状态' };
    expect(readNoteLearningProps(legacy)).toEqual({});
    const updated = updateNoteLearningProps(legacy, { course: '数学', chapter: '极限' });
    expect(updated).toEqual({ ...legacy, study_course: '数学', study_chapter: '极限' });
    expect(legacy).not.toHaveProperty('study_course');
    expect(readNoteLearningProps(updated)).toEqual({ course: '数学', chapter: '极限' });
  });

  it('validates the finite status and actual calendar date, and allows explicit clearing', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
    expect(isCalendarDate('2026-9-21')).toBe(false);
    expect(() => updateNoteLearningProps({}, { mastery: 'finished' })).toThrow();
    expect(() => updateNoteLearningProps({}, { reviewDate: '2026-02-29' })).toThrow();
    expect(updateNoteLearningProps({ study_mastery: '旧值', due: 'tomorrow' }, { mastery: 'mastered' }))
      .toEqual({ study_mastery: 'mastered', due: 'tomorrow' });
    expect(updateNoteLearningProps({ study_review_date: '2026-09-21', due: 'tomorrow' }, { reviewDate: '' }))
      .toEqual({ due: 'tomorrow' });
  });

  it('respects the shared property quota and case-insensitive legacy key collisions', () => {
    const full = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`legacy_${i}`, 'keep']));
    expect(() => updateNoteLearningProps(full, { course: '数学' })).toThrow('32');
    expect(() => updateNoteLearningProps({ STUDY_COURSE: 'legacy' }, { course: '数学' })).toThrow('同名');
  });

  it('derives list and review from the same notes, including overdue and the seven-day boundary', () => {
    const note = (id: string, date?: string) => ({ id, name: id, type: 'note', metadata: { props: { study_review_date: date } } });
    const notes = [note('due', '2026-09-21'), note('old', '2026-09-01'), note('boundary', '2026-09-28'),
      note('later', '2026-09-29'), note('invalid', '2026-02-29'), note('unset'),
      { ...note('map', '2026-09-21'), type: 'mindmap' }];
    const now = new Date(2026, 8, 21, 23, 59);
    expect(selectLearningViewNotes(notes, 'list', now)).toHaveLength(6);
    expect(selectLearningViewNotes(notes, 'status', now)).toHaveLength(6);
    expect(selectLearningViewNotes(notes, 'review', now).map((entry) => entry.id)).toEqual(['old', 'due', 'boundary']);
  });

  it('detects metadata changes without serialization or key-order dependence', () => {
    expect(sameNoteLearningMetadata({ props: { study_mastery: 'learning', course: 'x' } }, { props: { course: 'x', study_mastery: 'learning' } })).toBe(true);
    expect(sameNoteLearningMetadata({ props: { study_mastery: 'learning' } }, { props: { study_mastery: 'mastered' } })).toBe(false);
    expect(sameNoteLearningMetadata({ props: { study_review_date: '2026-09-21' } }, {})).toBe(false);
    expect(sameNoteLearningMetadata({ tags: ['A'] }, { tags: ['B'] })).toBe(false);
  });
});
