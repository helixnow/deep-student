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
    await expect(component.getByRole('button', { name: 'AI 解析', exact: true })).toHaveCount(0);
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
    await expect(component.getByRole('button', { name: '我答对了', exact: true })).toHaveCount(0);
    await expect(component.getByRole('button', { name: '我答错了', exact: true })).toHaveCount(0);
    const explanation = component.getByRole('region', { name: '解析', exact: true });
    await expect(explanation).toContainText('代入计算');
    await explanation.getByRole('button', { name: 'AI 解析', exact: true }).click();
    await expect(explanation.getByRole('button', { name: 'AI 解析中...', exact: true })).toBeDisabled();
    const calls = await page.evaluate(() => (window as unknown as {
      __CT_INVOKE_CALLS__: Array<{ command: string; payload?: Record<string, unknown> }>;
    }).__CT_INVOKE_CALLS__);
    expect(calls.filter(call => call.command === 'qbank_ai_grade')).toMatchObject([{
      payload: { request: { question_id: 'q1', submission_id: null, mode: 'analyze' } },
    }]);
    expect(calls.filter(call => call.command === 'qbank_submit_practice')).toHaveLength(1);
    expect(calls.some(call => ['qbank_submit_answer', 'qbank_grade_practice_manually'].includes(call.command))).toBe(false);
    await explanation.getByRole('button', { name: '取消', exact: true }).click();
    await page.screenshot({ path: `/tmp/deepstudent-batch-result-${width}.png` });
    await component.getByRole('button', { name: '下一题', exact: true }).click();
    await expect(component.getByRole('button', { name: '我答对了', exact: true })).toBeVisible();
    await component.getByRole('button', { name: '我答对了', exact: true }).click();
    await expect(component.getByText('正确 2 题', { exact: true })).toBeVisible();
    await expect(component.getByText('待批改 0 题', { exact: true })).toBeVisible();
    await expect(component.getByRole('button', { name: '我答对了', exact: true })).toHaveCount(0);
    await expect(component.getByRole('button', { name: '我答错了', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('desktop answer shortcuts work after mouse focus and never submit the paper', async ({ mount, page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  const component = await mount(<BatchPracticeHarness />);
  await component.getByRole('radio', { name: 'A. 4' }).click();
  await page.keyboard.press('b');
  await expect(component.getByRole('radio', { name: 'B. 8' })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(component.getByText('请说明函数的单调性，并给出判断过程。')).toBeVisible();
  await component.getByRole('textbox', { name: '我的作答' }).fill('多行作答');
  await page.keyboard.press('Enter');
  await page.keyboard.type('继续说明');
  await expect(component.getByRole('textbox', { name: '我的作答' })).toHaveValue('多行作答\n继续说明');
  await component.getByRole('button', { name: '上一题' }).click();
  await expect(component.getByRole('radio', { name: 'B. 8' })).toBeChecked();
  await page.keyboard.press('a');
  await expect(component.getByRole('radio', { name: 'A. 4' })).toBeChecked();
  await component.getByRole('button', { name: '交卷', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('b');
  await page.keyboard.press('ArrowRight');
  await expect(component.getByRole('radio', { name: 'A. 4' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(component.getByText('正确 1 题', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/deepstudent-practice-shortcuts-desktop.png' });
});

test('mistake overlay starts on the answer surface and Enter advances instead of closing', async ({ mount, page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  const component = await mount(<BatchPracticeHarness mistakeOverlay />);
  const opener = component.getByRole('button', { name: '打开错题重做' });
  await opener.click();
  const modal = page.getByRole('dialog', { name: '错题重做' });
  await expect(modal).toBeFocused();
  await page.keyboard.press('2');
  await expect(modal.getByRole('radio', { name: 'B. 8' })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(modal.getByText('请说明函数的单调性，并给出判断过程。')).toBeVisible();
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(opener).toBeFocused();
});
