import React from 'react';
import { test, expect } from '@playwright/experimental-ct-react';
import { BatchPracticeHarness } from './BatchPracticeHarness';

for (const width of [390, 1280]) {
  test(`batch practice saves answers without revealing them at ${width}px`, async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const component = await mount(<BatchPracticeHarness />);
    await expect(component.getByText('综合练习')).toBeVisible();
    await component.getByRole('radio', { name: 'B. 8' }).check();
    await component.getByRole('button', { name: '下一题' }).click();
    await component.getByRole('textbox', { name: '我的作答' }).fill('先求导，再讨论导数的符号。');
    await component.getByRole('button', { name: '上一题' }).click();
    await expect(component.getByRole('radio', { name: 'B. 8' })).toBeChecked();
    await expect(component.getByText('回答正确')).toHaveCount(0);
    await component.getByRole('button', { name: '答题卡' }).click();
    if (width < 768) await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: `/tmp/deepstudent-batch-${width}.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (width < 768) await page.keyboard.press('Escape');
    await component.getByRole('button', { name: '交卷', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '交卷', exact: true }).click();
    await expect(component.getByText('正确 1 题', { exact: true })).toBeVisible();
    await expect(component.getByText('待批改 1 题', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: `/tmp/deepstudent-batch-result-${width}.png` });
  });
}
