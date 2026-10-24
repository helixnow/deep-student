import React from 'react';
import { test, expect } from '@playwright/experimental-ct-react';
import { ImportDraftHarness } from './ImportDraftHarness';

for (const width of [390, 1280]) {
  test(`shared-material draft remains selectable at ${width}px`, async ({ mount, page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.addStyleTag({content:'*, *::before, *::after { animation: none !important; transition: none !important; }'});
    const component = await mount(<ImportDraftHarness />);
    await expect(component.getByTestId('exam-uploader-summary')).toBeVisible();
    await expect(component.getByTestId('exam-uploader-summary-question')).toHaveCount(5);
    const confirm = component.getByRole('button', { name: '确认录入' });
    await expect(confirm).toBeVisible();
    await expect.poll(async () => component.getByTestId('exam-uploader-summary').evaluate(element => getComputedStyle(element).transform)).toBe('none');
    const box = await confirm.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(850);
    const first = component.getByTestId('exam-uploader-summary-question').first().getByRole('checkbox');
    await first.scrollIntoViewIfNeeded();
    await first.uncheck();
    await expect(first).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/deepstudent-qbank-draft-${width}.png` });
  });
}
