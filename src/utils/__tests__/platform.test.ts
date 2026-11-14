import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMobilePlatform, isWebUiShell, supportsStreamProtocol } from '../platform';

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

  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'],
    ['Linux armv8l', 'Mozilla/5.0 (Linux; Android 15)'],
  ])('enables HTTP streaming on %s WebUI but not the native mobile shell', (platform, ua) => {
    stubNavigator(platform, ua, 5);
    vi.stubGlobal('__DS_WEBUI__', false);
    expect(supportsStreamProtocol()).toBe(false);
    vi.stubGlobal('__DS_WEBUI__', true);
    expect(isWebUiShell()).toBe(true);
    expect(supportsStreamProtocol()).toBe(true);
  });
});
