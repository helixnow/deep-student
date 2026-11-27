import { describe, expect, it } from 'vitest';
import { BrowserHostFactsTracker } from '../src/host-facts.ts';

describe('BrowserHostFactsTracker', () => {
  it('deduplicates visited origins while preserving visit order and ignores non-http URLs', () => {
    const tracker = new BrowserHostFactsTracker(() => new Date('2026-11-27T00:00:00.000Z'));
    tracker.recordNavigation('https://example.com/a');
    tracker.recordNavigation('https://docs.example.org/guide');
    tracker.recordNavigation('https://example.com/b?q=1');
    tracker.recordNavigation('about:blank');
    tracker.recordNavigation('not a url');
    tracker.recordNavigation('http://localhost:8080/page');

    const snap = tracker.snapshot('bs_1', 'interactive', 2, 'https://example.com/b?q=1');
    expect(snap).toEqual({
      sessionId: 'bs_1',
      mode: 'interactive',
      visitedOrigins: [
        'https://example.com',
        'https://docs.example.org',
        'http://localhost:8080',
      ],
      blockedNavigations: [],
      latestScreenshot: null,
      downloadsCount: 2,
      userTakeoverCount: 0,
      actionCount: 0,
      finalUrl: 'https://example.com/b?q=1',
    });
  });

  it('caps blockedNavigations at 50 entries keeping the most recent ones', () => {
    let tick = 0;
    const tracker = new BrowserHostFactsTracker(() => new Date(1_700_000_000_000 + (tick++) * 1000));
    for (let i = 1; i <= 65; i += 1) {
      tracker.recordBlocked(`http://10.0.0.${i}/`, `private_${i}`);
    }
    const snap = tracker.snapshot('bs_2', 'remote', 0, null);
    expect(snap.blockedNavigations).toHaveLength(50);
    expect(snap.blockedNavigations[0]?.url).toBe('http://10.0.0.16/');
    expect(snap.blockedNavigations[49]?.url).toBe('http://10.0.0.65/');
    expect(snap.blockedNavigations[49]?.reason).toBe('private_65');
  });

  it('records screenshots, takeovers, actions, returns defensive copies, and resets cleanly', () => {
    const tracker = new BrowserHostFactsTracker(() => new Date('2026-11-27T12:00:00.000Z'));
    tracker.recordNavigation('https://example.com/');
    tracker.recordAction();
    tracker.recordAction();
    tracker.recordTakeover();
    tracker.recordScreenshot({
      path: '/tmp/artifacts/browser-screenshots/shot.png',
      locator: 'runtime://artifacts/browser-screenshots/shot.png',
      width: 1280,
      height: 720,
      capturedAt: '2026-11-27T12:00:00.000Z',
    });

    const first = tracker.snapshot('bs_3', 'headless', 1, 'https://example.com/');
    expect(first.actionCount).toBe(2);
    expect(first.userTakeoverCount).toBe(1);
    expect(first.latestScreenshot).toEqual({
      path: '/tmp/artifacts/browser-screenshots/shot.png',
      locator: 'runtime://artifacts/browser-screenshots/shot.png',
      width: 1280,
      height: 720,
      capturedAt: '2026-11-27T12:00:00.000Z',
    });

    // Mutating returned snapshot must not affect internal tracker state.
    first.visitedOrigins.push('https://mutated.invalid');
    expect(tracker.snapshot('bs_3', 'headless', 1, null).visitedOrigins).toEqual(['https://example.com']);

    tracker.reset();
    const afterReset = tracker.snapshot('bs_4', 'interactive', 0, null);
    expect(afterReset.visitedOrigins).toEqual([]);
    expect(afterReset.blockedNavigations).toEqual([]);
    expect(afterReset.latestScreenshot).toBeNull();
    expect(afterReset.userTakeoverCount).toBe(0);
    expect(afterReset.actionCount).toBe(0);
  });
});
