import { describe, expect, it } from 'vitest';
import { stripRecommendedMarker } from '../askUserLabel';

describe('stripRecommendedMarker', () => {
  it('removes trailing recommended markers the UI already shows as a badge', () => {
    expect(stripRecommendedMarker('20 张 · 基础问答卡（Recommended）')).toBe('20 张 · 基础问答卡');
    expect(stripRecommendedMarker('Basic cards (Recommended)')).toBe('Basic cards');
    expect(stripRecommendedMarker('精简版（推荐）')).toBe('精简版');
    expect(stripRecommendedMarker('Option A - Recommended')).toBe('Option A');
  });

  it('keeps labels that only mention recommendation mid-text or are just the marker', () => {
    expect(stripRecommendedMarker('按推荐顺序复习')).toBe('按推荐顺序复习');
    expect(stripRecommendedMarker('(推荐)')).toBe('(推荐)');
  });
});
