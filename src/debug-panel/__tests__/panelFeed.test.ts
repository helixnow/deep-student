import { describe, expect, it, vi } from 'vitest';
import { createPanelFeed } from '../panelFeed';

describe('createPanelFeed', () => {
  it('delivers synchronously in subscription order until unsubscribed', () => {
    const feed = createPanelFeed<number>();
    const calls: string[] = [];
    const offA = feed.subscribe((n) => calls.push(`a${n}`));
    feed.subscribe((n) => calls.push(`b${n}`));
    feed.publish(1);
    expect(calls).toEqual(['a1', 'b1']);
    offA();
    feed.publish(2);
    expect(calls).toEqual(['a1', 'b1', 'b2']);
  });

  it('skips a listener removed during delivery and does not call one added during delivery', () => {
    const feed = createPanelFeed();
    const calls: string[] = [];
    let offB = () => {};
    feed.subscribe(() => {
      calls.push('a');
      offB();
      feed.subscribe(() => calls.push('late'));
    });
    offB = feed.subscribe(() => calls.push('b'));
    feed.publish();
    expect(calls).toEqual(['a']);
  });

  it('reports a throwing listener without stopping the others or reaching the publisher', () => {
    const feed = createPanelFeed<string>();
    const reported: unknown[] = [];
    const reportError = vi.fn((error: unknown) => reported.push(error));
    vi.stubGlobal('reportError', reportError);
    try {
      const boom = new Error('listener failed');
      const seen: string[] = [];
      feed.subscribe(() => { throw boom; });
      feed.subscribe((detail) => seen.push(detail));
      expect(() => feed.publish('x')).not.toThrow();
      expect(seen).toEqual(['x']);
      expect(reported).toEqual([boom]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
