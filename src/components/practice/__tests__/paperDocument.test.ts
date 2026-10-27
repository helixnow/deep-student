import { describe, expect, it } from 'vitest';
import type { GeneratedPaper } from '@/stores/questionBankStore';
import { buildPaperSections, paperAnswer, sectionsToMarkdown } from '../paperDocument';

const labels = {
  material: 'Shared material',
  appendix: 'Answers',
  answer: 'Answer',
  explanation: 'Explanation',
  questions: 'Questions',
};
const paper = {
  id: 'p1',
  title: 'Paper',
  exam_id: 'e1',
  created_at: '',
  total_score: 2,
  config: { include_answers: false, include_explanations: false },
  questions: [1, 2].map((n) => ({
    id: `q${n}`,
    content: `Question ${n}`,
    question_type: 'single_choice',
    options: [{ key: 'A', content: 'Choice' }],
    answer: 'A',
    explanation: 'Because',
    materials: [
      {
        id: 'm1',
        content: 'Read this passage',
        images: [{ id: 'img1', mime: 'image/png', name: 'Figure', hash: 'hash' }],
      },
    ],
    images: [],
  })),
} as unknown as GeneratedPaper;

describe('paper document', () => {
  it('places one shared material before its questions and moves answers to the appendix', () => {
    const sections = buildPaperSections(
      paper,
      { includeAnswers: true, includeExplanations: true },
      labels,
    );
    const markdown = sectionsToMarkdown(sections);
    expect(markdown.match(/Read this passage/g)).toHaveLength(1);
    expect(markdown).toContain('Questions 1, 2');
    expect(markdown).toContain('attachment://img1');
    expect(markdown.indexOf('Answers')).toBeGreaterThan(markdown.indexOf('Question 2'));
    expect(sections.find((s) => s.kind === 'heading' && s.text === 'Answers')).toMatchObject({
      pageBreak: true,
    });
  });
  it('honors export visibility without modifying the frozen questions', () => {
    const markdown = sectionsToMarkdown(
      buildPaperSections(paper, { includeAnswers: false, includeExplanations: false }, labels),
    );
    expect(markdown).not.toContain('Because');
    expect(markdown).not.toContain('# Answers');
    expect(paper.questions[0].answer).toBe('A');
  });
  it('includes structured reference answers when no legacy answer string exists', () => {
    expect(
      paperAnswer({
        question_type: 'ordering',
        structured_data: {
          items: [
            { key: 'A', content: 'a' },
            { key: 'B', content: 'b' },
          ],
          correct_order: ['B', 'A'],
        },
      } as never),
    ).toBe('B → A');
    expect(
      paperAnswer({
        question_type: 'numeric',
        structured_data: { answer_value: 3.14, tolerance: 0.01, unit: 'm' },
      } as never),
    ).toContain('3.14');
    expect(paperAnswer({ question_type: 'fill_blank', structured_data: { blanks: [{ answers: ['x', 'X'] }, { answers: ['2'] }] } } as never)).toBe('1. x / X\n2. 2');
  });
});
