import { describe, expect, it } from 'vitest';
import {
  REVIEW_QUALITY_BY_KEY,
  REVIEW_RATING_QUALITY,
  formatReviewInterval,
  reviewIntervalLabels,
} from '../reviewRatingPreview';

const t = (key: string, { count }: { count: number }) => `${count}${key.split('.').pop()}`;

describe('question-bank FSRS rating buttons (D2)', () => {
  it('sends 0 / 3 / 4 / 5 so the host maps them to again / hard / good / easy', () => {
    expect(REVIEW_RATING_QUALITY).toEqual({ again: 0, hard: 3, good: 4, easy: 5 });
    expect(REVIEW_QUALITY_BY_KEY).toEqual({ '1': 0, '2': 3, '3': 4, '4': 5 });
  });

  it('formats minute learning steps and day intervals with one scale', () => {
    expect(formatReviewInterval(t, 1)).toBe('1minutes');
    expect(formatReviewInterval(t, 10)).toBe('10minutes');
    expect(formatReviewInterval(t, 180)).toBe('3hours');
    expect(formatReviewInterval(t, 1440)).toBe('1days');
    expect(formatReviewInterval(t, 4 * 1440)).toBe('4days');
    expect(formatReviewInterval(t, 21 * 1440)).toBe('3weeks');
    expect(formatReviewInterval(t, 90 * 1440)).toBe('3months');
    expect(formatReviewInterval(t, 800 * 1440)).toBe('2years');
  });

  it('labels the four buttons from the host previews and stays empty without them', () => {
    const preview = (minutes: number) => ({ interval_minutes: minutes, next_review_date: '2026-11-15' });
    expect(reviewIntervalLabels(t, {
      rating_previews: { again: preview(1), hard: preview(6), good: preview(10), easy: preview(4 * 1440) },
    })).toEqual({ again: '1minutes', hard: '6minutes', good: '10minutes', easy: '4days' });
    expect(reviewIntervalLabels(t, {})).toEqual({ again: '', hard: '', good: '', easy: '' });
  });
});
