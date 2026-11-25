import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  normalizePracticeFeedbackMarkdown,
  parsePracticeManualOverride,
} from '../practiceFeedbackMarkdown';

describe('practiceFeedbackMarkdown (S2-05)', () => {
  it('repairs single-line collapsed GFM rubric tables into a clean 4-column HTML table and strips grading XML tags', () => {
    const raw =
      '### 逐点批改\n| 评分项 | 满分 | 得分 | 说明 | | --- | --- | --- | --- | | 公式列出 | 50 | 50 | 完全正确 | | 推导过程 | 50 | 0 | 缺少关键步骤 |\n<verdict>partial</verdict><score value="50"/><manual_override score="0" status="incorrect" original_score="100" original_status="correct"/>';

    const cleaned = normalizePracticeFeedbackMarkdown(raw);
    expect(cleaned).not.toContain('<verdict>');
    expect(cleaned).not.toContain('<score');
    expect(cleaned).not.toContain('<manual_override');

    const { container } = render(<ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll('thead th').length).toBe(4);
    expect(table?.querySelectorAll('tbody tr').length).toBe(2);
    expect(table?.querySelectorAll('tbody td').length).toBe(8);
  });

  it('reconciles mismatched separator column count and overflow pipes inside comment cells so remark-gfm renders a valid table', () => {
    const raw = [
      '总体评价：部分得分。',
      '| 得分点 | 分值 | 得分 | 详细评语 |',
      '| --- | --- | --- |',
      '| 要点A | 40 | 40 | 讨论了情况1 | 情况2 |',
      '| 要点B | 60 | 20 |',
    ].join('\n');

    const cleaned = normalizePracticeFeedbackMarkdown(raw);
    const { container } = render(<ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll('thead th').length).toBe(4);
    expect(table?.querySelectorAll('tbody tr').length).toBe(2);
    expect(container.textContent).toContain('讨论了情况1 ｜ 情况2');
  });

  it('parses persisted manual_override metadata from feedback', () => {
    const raw =
      '本题满分作答。\n<verdict>correct</verdict><score value="100"/>\n<manual_override score="0" status="incorrect" original_score="100" original_status="correct"/>';

    expect(parsePracticeManualOverride(raw)).toEqual({
      score: 0,
      status: 'incorrect',
      originalScore: 100,
      originalStatus: 'correct',
    });
    expect(parsePracticeManualOverride('普通评语无人工改判')).toBeNull();
  });
});
