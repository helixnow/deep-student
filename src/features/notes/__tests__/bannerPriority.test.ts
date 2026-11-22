import { describe, expect, it } from 'vitest';
import {
  BANNER_PRIORITY_ORDER,
  getBannerPriority,
  isBannerVisible,
  resolveBannerSlots,
  sortBannersByPriority,
  type BannerId,
} from '../bannerPriority';

describe('bannerPriority', () => {
  it('returns empty slots when no banners are active', () => {
    expect(resolveBannerSlots([])).toEqual({
      primary: null,
      secondary: [],
      queued: [],
      hiddenCount: 0,
    });
  });

  it('places a single active banner into primary with nothing queued', () => {
    expect(resolveBannerSlots(['review-due'])).toEqual({
      primary: 'review-due',
      secondary: [],
      queued: [],
      hiddenCount: 0,
    });
  });

  it('strictly enforces the full priority ladder from conflict down to review-due', () => {
    const reversed = [...BANNER_PRIORITY_ORDER].reverse();
    expect(sortBannersByPriority(reversed)).toEqual([...BANNER_PRIORITY_ORDER]);

    for (let i = 0; i < BANNER_PRIORITY_ORDER.length - 1; i += 1) {
      expect(getBannerPriority(BANNER_PRIORITY_ORDER[i])).toBeLessThan(
        getBannerPriority(BANNER_PRIORITY_ORDER[i + 1]),
      );
    }
  });

  it('prevents stacking 4+ banners by showing only the highest-priority primary and queuing the rest', () => {
    const slots = resolveBannerSlots([
      'review-due',
      'agent-write',
      'recovery-draft',
      'host-refresh-error',
      'recovered-drafts',
    ]);

    expect(slots).toEqual({
      primary: 'host-refresh-error',
      secondary: [],
      queued: ['recovery-draft', 'recovered-drafts', 'agent-write', 'review-due'],
      hiddenCount: 4,
    });
  });

  it('keeps conflict as primary while preserving active ai-diff in secondary', () => {
    const slots = resolveBannerSlots(['review-due', 'ai-diff', 'conflict', 'agent-write']);

    expect(slots).toEqual({
      primary: 'conflict',
      secondary: ['ai-diff'],
      queued: ['agent-write', 'review-due'],
      hiddenCount: 2,
    });
  });

  it('does not duplicate ai-diff into secondary when ai-diff itself is primary', () => {
    const slots = resolveBannerSlots(['review-due', 'ai-diff', 'ai-checkpoint']);

    expect(slots).toEqual({
      primary: 'ai-diff',
      secondary: [],
      queued: ['ai-checkpoint', 'review-due'],
      hiddenCount: 2,
    });
  });

  it('queues ai-diff when allowCoVisibleAiDiff is disabled', () => {
    const slots = resolveBannerSlots(['conflict', 'ai-diff', 'review-due'], {
      allowCoVisibleAiDiff: false,
    });

    expect(slots).toEqual({
      primary: 'conflict',
      secondary: [],
      queued: ['ai-diff', 'review-due'],
      hiddenCount: 2,
    });
  });

  it('deduplicates repeated banner IDs', () => {
    const slots = resolveBannerSlots([
      'draft-persistence-error',
      'conflict',
      'conflict',
      'review-due',
      'review-due',
    ]);

    expect(slots).toEqual({
      primary: 'conflict',
      secondary: [],
      queued: ['draft-persistence-error', 'review-due'],
      hiddenCount: 2,
    });
  });

  it('evaluates isBannerVisible accurately in collapsed and expanded states', () => {
    const slots = resolveBannerSlots(['conflict', 'ai-diff', 'recovery-draft', 'review-due']);

    expect(isBannerVisible(slots, 'conflict')).toBe(true);
    expect(isBannerVisible(slots, 'ai-diff')).toBe(true);
    expect(isBannerVisible(slots, 'recovery-draft')).toBe(false);
    expect(isBannerVisible(slots, 'review-due')).toBe(false);
    expect(isBannerVisible(slots, 'host-refresh-error')).toBe(false);

    // Expanded "+N" reveals queued banners without showing inactive ones
    expect(isBannerVisible(slots, 'recovery-draft', true)).toBe(true);
    expect(isBannerVisible(slots, 'review-due', true)).toBe(true);
    expect(isBannerVisible(slots, 'host-refresh-error', true)).toBe(false);
  });

  it('ignores unknown runtime values defensively', () => {
    const noisy = ['unknown-banner' as BannerId, 'ai-recovery', 'ai-collapsed'];
    expect(resolveBannerSlots(noisy)).toEqual({
      primary: 'ai-recovery',
      secondary: [],
      queued: ['ai-collapsed'],
      hiddenCount: 1,
    });
  });
});
