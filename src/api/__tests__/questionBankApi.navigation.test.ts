import { describe, expect, it } from 'vitest';
import { getNextQuestionIndex, getPracticeStartIndex, type Question } from '@/api/questionBankApi';

function question(
  id: string,
  tags: string[],
  status: Question['status'] = 'new',
): Question {
  return {
    id,
    questionLabel: id,
    content: id,
    questionType: 'single_choice',
    tags,
    status,
  };
}

describe('getNextQuestionIndex', () => {
  it('keeps the current question when by_tag has no selected tag', () => {
    const questions = [question('a', ['algebra']), question('b', ['geometry'])];

    expect(getNextQuestionIndex(questions, 1, 'by_tag')).toBe(1);
  });

  it('never falls through to questions outside the selected tag', () => {
    const questions = [
      question('algebra-mastered', ['algebra'], 'mastered'),
      question('geometry', ['geometry']),
      question('algebra-review', ['algebra'], 'review'),
    ];

    expect(getNextQuestionIndex(questions, 0, 'by_tag', 'algebra')).toBe(2);
    expect(getNextQuestionIndex(questions, 2, 'by_tag', 'algebra')).toBe(2);
    expect(getNextQuestionIndex(questions, 1, 'by_tag', 'missing-tag')).toBe(1);
  });

  it('keeps fully mastered and untagged practice within the selected scope', () => {
    const questions = [
      question('algebra-mastered', ['algebra'], 'mastered'),
      question('geometry', ['geometry']),
      question('untagged', []),
    ];

    expect(getNextQuestionIndex(questions, 1, 'by_tag', 'algebra')).toBe(0);
    expect(getNextQuestionIndex(questions, 0, 'by_tag', '__untagged__')).toBe(2);
  });
});

describe('getPracticeStartIndex', () => {
  const qs = (attempts: number[]) => attempts.map((attemptCount, i) => ({ id: `q${i}`, attemptCount } as Question));

  it('sequential stays on an unanswered current question instead of skipping it', () => {
    expect(getPracticeStartIndex(qs([0, 0, 0]), 0, 'sequential')).toBe(0);
    expect(getPracticeStartIndex(qs([1, 0, 0]), 1, 'sequential')).toBe(1);
  });

  it('sequential moves on once the current question was answered', () => {
    expect(getPracticeStartIndex(qs([1, 0, 0]), 0, 'sequential')).toBe(1);
  });
});
