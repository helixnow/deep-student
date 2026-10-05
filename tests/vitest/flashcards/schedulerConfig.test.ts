import { describe, expect, it } from 'vitest';
import {
  formatSteps,
  hasDayLongStep,
  parseOptimizeResult,
  parseSchedulerConfig,
  parseStepsInput,
} from '@/features/flashcards/schedulerConfig';

describe('scheduler config helpers', () => {
  it('parses Anki-style learning steps into minutes', () => {
    expect(parseStepsInput('1m 10m')).toEqual([1, 10]);
    expect(parseStepsInput('30s, 1h 2d')).toEqual([0.5, 60, 2880]);
    expect(parseStepsInput('15')).toEqual([15]);
    expect(parseStepsInput('   ')).toEqual([]);
  });

  it('rejects malformed or out-of-range steps', () => {
    expect(parseStepsInput('1x')).toBeNull();
    expect(parseStepsInput('0m')).toBeNull();
    expect(parseStepsInput('400d')).toBeNull();
    expect(parseStepsInput(Array.from({ length: 17 }, () => '1m').join(' '))).toBeNull();
  });

  it('formats minutes back with the largest exact unit', () => {
    expect(formatSteps([1, 10])).toBe('1m 10m');
    expect(formatSteps([0.5, 60, 1440, 90])).toBe('30s 1h 1d 90m');
    expect(parseStepsInput(formatSteps([0.5, 60, 1440, 90]))).toEqual([0.5, 60, 1440, 90]);
  });

  it('flags steps of a day or longer', () => {
    expect(hasDayLongStep([1, 10])).toBe(false);
    expect(hasDayLongStep([10, 1440])).toBe(true);
  });

  it('reads the extended scheduler config with defaults for older backends', () => {
    const legacy = parseSchedulerConfig({ newPerDay: 20, reviewsPerDay: 200, desiredRetention: 0.9 });
    expect(legacy).toMatchObject({
      learningSteps: [1, 10],
      relearningSteps: [10],
      dayRolloverHour: 4,
      enableFuzz: true,
      fsrsParams: [],
      fsrsOptimizedAtMs: null,
    });
    const current = parseSchedulerConfig({
      new_per_day: 10,
      reviews_per_day: 100,
      desired_retention: 0.85,
      learning_steps: [5],
      relearning_steps: [],
      day_rollover_hour: 0,
      maximum_interval: 365,
      enable_fuzz: false,
      fsrs_params: [0.2, 1.2],
      fsrs_optimized_at_ms: 1_000,
      fsrs_optimized_review_count: 512,
    });
    expect(current).toMatchObject({
      learningSteps: [5],
      relearningSteps: [],
      dayRolloverHour: 0,
      maximumInterval: 365,
      enableFuzz: false,
      fsrsParams: [0.2, 1.2],
      fsrsOptimizedAtMs: 1_000,
      fsrsOptimizedReviewCount: 512,
    });
  });

  it('parses optimizer results and rejects unknown statuses', () => {
    expect(parseOptimizeResult({
      status: 'optimized',
      cardCount: 3,
      itemCount: 40,
      reviewCount: 120,
      current: { logLoss: 0.4, rmseBins: 0.05 },
      optimized: { log_loss: 0.35, rmse_bins: 0.04 },
      recomputedCards: 3,
    })).toEqual({
      status: 'optimized',
      cardCount: 3,
      itemCount: 40,
      reviewCount: 120,
      current: { logLoss: 0.4, rmseBins: 0.05 },
      optimized: { logLoss: 0.35, rmseBins: 0.04 },
      recomputedCards: 3,
    });
    expect(parseOptimizeResult({ status: 'weird' })).toBeNull();
  });
});
