/**
 * QuestionBankListView 工具栏按钮无障碍 — source 守卫
 *
 * 回归防线：题库工具栏三个图标按钮的 aria-label 曾硬编码英文
 * "favorites" / "add question" / "batch manage"，
 * 屏幕阅读器用户（尤其非英文 locale）听到的是与界面语言不符的英文。
 * 现约定复用既有 locale key，不新增词条：
 * - 收藏筛选 → learningHub:exam.tab.favorites（ExamContentView 同用）；
 * - 手动添加题目 → learningHub:exam.tab.addQuestion（ExamContentView 同用）；
 * - 批量管理 → exam_sheet:questionBank.manage（与按钮可见文本同 key，
 *   满足 WCAG 2.5.3 Label in Name）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(process.cwd(), 'src/components/QuestionBankListView.tsx'),
  'utf8'
);

describe('QuestionBankListView toolbar button accessibility', () => {
  it('no longer hardcodes english aria-labels', () => {
    expect(source).not.toContain('aria-label="favorites"');
    expect(source).not.toContain('aria-label="add question"');
    expect(source).not.toContain('aria-label="batch manage"');
  });

  it('labels the favorites filter via the existing exam.tab.favorites key', () => {
    expect(source).toContain(
      "aria-label={t('learningHub:exam.tab.favorites', { defaultValue: '收藏' })}"
    );
  });

  it('labels the add-question button via the existing exam.tab.addQuestion key', () => {
    expect(source).toContain(
      "aria-label={t('learningHub:exam.tab.addQuestion', { defaultValue: '添加题目' })}"
    );
  });

  it('labels batch manage with the same key as its visible text (WCAG 2.5.3)', () => {
    expect(source).toContain(
      "aria-label={t('exam_sheet:questionBank.manage', { defaultValue: '管理' })}"
    );
  });
});
