import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMobilePlatform } from '../platform';

function stubNavigator(platform: string, userAgent: string, maxTouchPoints = 0): void {
  vi.stubGlobal('navigator', {
    platform,
    userAgent,
    maxTouchPoints,
  });
}

describe('isMobilePlatform', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects iPadOS when it uses a desktop-class Mac user agent', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5);
    expect(isMobilePlatform()).toBe(true);
  });

  it('does not classify a desktop Mac as mobile', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 0);
    expect(isMobilePlatform()).toBe(false);
  });

  it('keeps explicit Android and iPhone detection', () => {
    stubNavigator('Linux armv8l', 'Mozilla/5.0 (Linux; Android 15)', 5);
    expect(isMobilePlatform()).toBe(true);

    stubNavigator('iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 5);
    expect(isMobilePlatform()).toBe(true);
  });
});
