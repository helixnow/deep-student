import React from 'react';
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import enEssay from '@/locales/en-US/essay_grading.json';
import type { ParsedScore } from '@/essay-grading/streamingMarkerParser';

const i18n = i18next.createInstance();
void i18n.init({
  lng: 'en-US',
  fallbackLng: false,
  resources: { 'en-US': { essay_grading: enEssay } },
  ns: ['essay_grading'],
  defaultNS: 'essay_grading',
  interpolation: { escapeValue: false },
  initImmediate: false,
});
const t = i18n.getFixedT('en-US', 'essay_grading');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));

import { ScoreCard } from '../ScoreCard';

const score: ParsedScore = {
  total: 45,
  maxTotal: 60,
  grade: 'good',
  dimensions: [
    { name: '内容', score: 16, maxScore: 20 },
    { name: '表达', score: 15, maxScore: 20 },
    { name: '发展等级', score: 14, maxScore: 20 },
  ],
  isComplete: true,
};

describe('ScoreCard built-in dimension labels', () => {
  it('shows English labels for an untouched built-in mode in the English UI', () => {
    render(<ScoreCard score={score} gradingModeId="gaokao" />);
    expect(screen.getAllByText('Content').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Development Level').length).toBeGreaterThan(0);
    expect(screen.queryByText('内容')).toBeNull();
  });

  it('keeps dimension names verbatim for custom modes', () => {
    render(<ScoreCard score={score} gradingModeId="custom-123" />);
    expect(screen.getAllByText('内容').length).toBeGreaterThan(0);
    expect(screen.queryByText('Content')).toBeNull();
  });
});
