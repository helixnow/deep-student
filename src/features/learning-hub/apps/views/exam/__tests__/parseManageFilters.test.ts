import { describe, expect, it } from 'vitest';
import type { Question } from '@/api/questionBankApi';
import {
  controlStringArray,
  matchesPracticeTag,
  parseManageFilters,
} from '../ExamViewPrimitives';

describe('controlStringArray', () => {
  it('returns trimmed-non-empty strings and rejects non-arrays or non-string entries', () => {
    expect(controlStringArray(['a', '  ', 'b', ''])).toEqual(['a', 'b']);
    expect(controlStringArray([])).toEqual([]);
    expect(controlStringArray('not-array')).toBeUndefined();
    expect(controlStringArray(['a', 123])).toBeUndefined();
    expect(controlStringArray(null)).toBeUndefined();
  });
});

describe('parseManageFilters', () => {
  it('returns null for null, primitives, and arrays', () => {
    expect(parseManageFilters(null)).toBeNull();
    expect(parseManageFilters(undefined)).toBeNull();
    expect(parseManageFilters('search')).toBeNull();
    expect(parseManageFilters(42)).toBeNull();
    expect(parseManageFilters([])).toBeNull();
  });

  it('parses direct payload with snake_case and camelCase aliases', () => {
    expect(
      parseManageFilters({
        search: 'matrix',
        status: ['review', 'mastered', ''],
        difficulty: ['hard'],
        question_type: ['single_choice', 'proof'],
        tags: ['linear-algebra', '   '],
        is_favorite: true,
      }),
    ).toEqual({
      search: 'matrix',
      status: ['review', 'mastered'],
      difficulty: ['hard'],
      questionType: ['single_choice', 'proof'],
      tags: ['linear-algebra'],
      isFavorite: true,
    });

    expect(
      parseManageFilters({
        questionType: ['fill_blank'],
        isFavorite: false,
      }),
    ).toEqual({
      search: undefined,
      status: undefined,
      difficulty: undefined,
      questionType: ['fill_blank'],
      tags: undefined,
      isFavorite: false,
    });
  });

  it('unwraps nested `filters` object when provided and prefers snake_case over camelCase when both set', () => {
    expect(
      parseManageFilters({
        filters: {
          search: 'eigenvalue',
          status: ['new'],
          question_type: ['essay'],
          questionType: ['numeric'],
          is_favorite: false,
          isFavorite: true,
        },
      }),
    ).toEqual({
      search: 'eigenvalue',
      status: ['new'],
      difficulty: undefined,
      questionType: ['essay'],
      tags: undefined,
      isFavorite: false,
    });
  });

  it('ignores non-object `filters` field and malformed field types', () => {
    expect(
      parseManageFilters({
        filters: ['not-an-object'],
        search: 123,
        status: 'review',
        difficulty: [1, 2],
        tags: ['valid'],
        is_favorite: 'yes',
      }),
    ).toEqual({
      search: undefined,
      status: undefined,
      difficulty: undefined,
      questionType: undefined,
      tags: ['valid'],
      isFavorite: undefined,
    });
  });
});

describe('matchesPracticeTag', () => {
  const baseQuestion: Question = {
    id: 'q1',
    content: 'Test',
    questionType: 'single_choice',
    status: 'new',
  };

  it('matches untagged sentinel only when question has no tags', () => {
    expect(matchesPracticeTag({ ...baseQuestion, tags: undefined }, '__untagged__')).toBe(true);
    expect(matchesPracticeTag({ ...baseQuestion, tags: [] }, '__untagged__')).toBe(true);
    expect(matchesPracticeTag({ ...baseQuestion, tags: ['math'] }, '__untagged__')).toBe(false);
  });

  it('matches exact tag membership', () => {
    expect(matchesPracticeTag({ ...baseQuestion, tags: ['math', 'calculus'] }, 'calculus')).toBe(true);
    expect(matchesPracticeTag({ ...baseQuestion, tags: ['math'] }, 'calculus')).toBe(false);
    expect(matchesPracticeTag({ ...baseQuestion, tags: undefined }, 'math')).toBe(false);
  });
});
