import React from 'react';
import { test, expect, type Locator } from '@playwright/experimental-ct-react';
import { StructureManagerHarness } from './managementHarness';

const VIEWPORT_HEIGHT = 900;

interface Box {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(name: string, locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  return { name, ...box! };
}

function assertNoOverlap(boxes: Box[]) {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlaps =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      expect(overlaps, `${a.name} overlaps ${b.name}`).toBe(false);
    }
  }
}

for (const width of [390, 1280]) {
  test(`structure manager shows canonical groups and materials at ${width}px`, async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });

    await mount(<StructureManagerHarness />);

    const dialog = page.getByRole('dialog', { name: '题组与材料' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('heading', { name: '题组与材料' })).toBeVisible();
    await expect(
      page.getByText('管理题组成员与顺序、关联共享材料，以及解散或删除题组。'),
    ).toBeVisible();

    const groupOne = page.getByRole('region', { name: '阅读理解一' });
    await expect(groupOne).toBeVisible();
    await expect(groupOne.getByText('3 道子题')).toBeVisible();
    await expect(groupOne.getByText(/1 · 阅读材料第一题/)).toBeVisible();
    await expect(groupOne.getByText(/2 · 阅读材料第二题/)).toBeVisible();
    await expect(groupOne.getByText(/3 · 阅读材料第三题/)).toBeVisible();
    await expect(groupOne.getByRole('button', { name: /共享阅读材料一/ })).toBeVisible();
    await expect(groupOne.getByRole('button', { name: '编辑题组名称' })).toBeVisible();

    await page.screenshot({ path: `/tmp/deepstudent-import-fix-structure-${width}.png` });

    const footerReload = page.getByRole('button', { name: '重新载入' });
    const footerClose = page.getByRole('button', { name: '关闭' }).last();
    await expect(footerReload).toBeVisible();
    await expect(footerClose).toBeVisible();

    await groupOne.scrollIntoViewIfNeeded();
    const editLabel = groupOne.getByRole('button', { name: '编辑题组名称' });
    const addMember = groupOne.getByRole('button', { name: '添加子题' });
    const dissolveGroup = groupOne.getByRole('button', { name: '解散题组' });
    const deleteGroup = groupOne.getByRole('button', { name: '删除题组及子题' });
    for (const button of [editLabel, addMember, dissolveGroup, deleteGroup]) {
      await expect(button).toBeInViewport();
    }

    const controls = [
      await boxOf('edit label', editLabel),
      await boxOf('add member', addMember),
      await boxOf('dissolve group', dissolveGroup),
      await boxOf('delete group', deleteGroup),
    ];
    assertNoOverlap(controls);

    for (const box of controls) {
      expect(box.x, box.name).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, box.name).toBeLessThanOrEqual(width + 1);
    }

    // The second group is below the fold on mobile; scroll it into view to
    // prove the canonical structure (not just the first card) is loaded.
    const groupTwo = page.getByRole('region', { name: '完形填空' });
    await groupTwo.scrollIntoViewIfNeeded();
    await expect(groupTwo).toBeVisible();
    await expect(groupTwo.getByText(/4 · 完形填空第一题/)).toBeVisible();
    await expect(page.getByRole('region', { name: '语法填空' })).toHaveCount(1);

    // Unused materials are listed in their own section and remain actionable.
    await expect(page.getByText('未使用材料')).toBeVisible();
    const deleteMaterial = page.getByRole('button', { name: /删除材料/ }).first();
    await deleteMaterial.scrollIntoViewIfNeeded();
    await expect(deleteMaterial).toBeInViewport();
    const deleteMaterialBox = await boxOf('unused material delete', deleteMaterial);
    expect(deleteMaterialBox.x).toBeGreaterThanOrEqual(0);
    expect(deleteMaterialBox.x + deleteMaterialBox.width).toBeLessThanOrEqual(width + 1);

    const footerBoxes = [
      await boxOf('footer reload', footerReload),
      await boxOf('footer close', footerClose),
    ];
    assertNoOverlap(footerBoxes);
    for (const box of footerBoxes) {
      expect(box.y, box.name).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, box.name).toBeLessThanOrEqual(VIEWPORT_HEIGHT + 1);
      expect(box.x + box.width, box.name).toBeLessThanOrEqual(width + 1);
    }

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width + 1);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(VIEWPORT_HEIGHT + 1);
    expect(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  });
}

test('structure manager mutations use the isolated mock state and reload canonical data', async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: VIEWPORT_HEIGHT });
  await mount(<StructureManagerHarness />);

  const groupOne = page.getByRole('region', { name: '阅读理解一' });
  await expect(groupOne.getByText(/1 · 阅读材料第一题/)).toBeVisible();

  await groupOne.getByRole('button', { name: '下移' }).first().click();

  await expect(groupOne.locator('li').first()).toContainText('2 · 阅读材料第二题');
  await expect(groupOne.locator('li').nth(1)).toContainText('1 · 阅读材料第一题');
  await expect(groupOne.locator('li').nth(2)).toContainText('3 · 阅读材料第三题');

  const updateCall = await page.evaluate(() => {
    const calls = ((window as unknown as { __CT_INVOKE_CALLS__?: Array<{
      command: string;
      payload?: Record<string, unknown>;
    }> }).__CT_INVOKE_CALLS__) ?? [];
    return calls.find((call) => call.command === 'qbank_update_group');
  });

  expect(updateCall?.payload).toMatchObject({
    groupId: 'g1',
    label: '阅读理解一',
    questionIds: ['q2', 'q1', 'q3'],
    materialIds: ['m1'],
    expectedVersion: 3,
  });
});
