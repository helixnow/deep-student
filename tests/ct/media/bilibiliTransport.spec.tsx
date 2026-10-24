import React from 'react';
import { test, expect } from '@playwright/experimental-ct-react';
import { BilibiliTransportHarness } from './BilibiliTransportHarness';

for (const width of [390, 1280]) {
  test(`pairing approval, independent account and capability fit ${width}px`, async ({ mount, page }) => {
    await page.setViewportSize({ width, height: 800 });
    const component = await mount(<BilibiliTransportHarness />);
    await expect(component.getByText('Browser account', { exact: true })).toBeVisible();
    const approve = component.getByRole('button', { name: '确认此浏览器配对' });
    await approve.click();
    const calls = await page.evaluate(() => (window as unknown as { __CT_INVOKE_CALLS__: Array<{ command: string; payload?: Record<string, unknown> }> }).__CT_INVOKE_CALLS__);
    expect(calls).toContainEqual({ command: 'media_bilibili_bridge_approve', payload: { connectionId: 'fixture' } });
    const box = await component.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/deepstudent-bilibili-transport-${width}.png` });
  });
}
