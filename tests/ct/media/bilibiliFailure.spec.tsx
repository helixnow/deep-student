import React from 'react';
import { test, expect } from '@playwright/experimental-ct-react';
import { BilibiliEmbedHarness } from './BilibiliEmbedHarness';

for (const width of [390, 1280]) {
  test(`frame timeout and reload remain visible at ${width}px`, async ({ mount, page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.clock.install();
    await page.route('https://player.bilibili.com/**', () => new Promise(() => {}));
    const component = await mount(<BilibiliEmbedHarness />);
    await page.clock.fastForward(20_100);
    const alert = component.getByRole('alert');
    await expect(alert).toBeVisible();
    const box = await alert.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const retry = component.getByRole('button', { name: '重新加载 B 站播放器' });
    await expect(retry).toBeVisible();
    await page.screenshot({ path: `/tmp/deepstudent-bilibili-timeout-${width}.png` });
    await retry.click();
    await expect(alert).toHaveCount(0);
  });
}
