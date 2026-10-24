import React from 'react';
import { test, expect } from '@playwright/experimental-ct-react';
import { AuditPanelHarness } from './managementHarness';

const VIEWPORT_HEIGHT = 900;

for (const width of [390, 1280]) {
  test(`import audit panel renders legacy cards and reparse report at ${width}px`, async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });

    await mount(<AuditPanelHarness />);

    const panel = page.getByTestId('question-import-audit-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByRole('heading', { name: '历史导入审计与重解析复核' })).toBeVisible();
    await expect(
      page.getByText('仅按 card_id/id 建立身份映射；不会猜测语义对应，也不会覆盖已有正式题目。'),
    ).toBeVisible();

    const summary = page.getByTestId('legacy-audit-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('预览卡片: 4');
    await expect(page.getByTestId('audit-matched-count')).toContainText('已映射: 1');
    await expect(page.getByTestId('audit-unmatched-count')).toContainText('待迁移: 2');
    await expect(page.getByTestId('audit-ambiguous-count')).toContainText('歧义: 1');

    const refresh = page.getByTestId('legacy-audit-refresh');
    const selectAll = page.getByTestId('legacy-select-all');
    const migrateSelected = page.getByTestId('legacy-migrate-selected');
    await expect(refresh).toBeInViewport();
    await selectAll.scrollIntoViewIfNeeded();
    await expect(selectAll).toBeInViewport();
    await expect(migrateSelected).toBeInViewport();
    const selectAllBox = await selectAll.boundingBox();
    const migrateBox = await migrateSelected.boundingBox();
    expect(selectAllBox).not.toBeNull();
    expect(migrateBox).not.toBeNull();
    expect(
      selectAllBox!.x + selectAllBox!.width <= migrateBox!.x
      || migrateBox!.x + migrateBox!.width <= selectAllBox!.x,
    ).toBe(true);

    const pageAssets = page.getByTestId('audit-page-assets');
    await expect(pageAssets).toContainText('blob_legacy_p1');
    await expect(pageAssets).toContainText('/fixtures/legacy-page-01.png');

    await expect(page.getByTestId('legacy-card-card_match_1')).toBeVisible();
    await expect(page.getByTestId('legacy-card-card_new_1')).toBeVisible();
    await expect(page.getByTestId('legacy-card-card_new_2')).toBeVisible();
    await expect(page.getByTestId('legacy-card-card_ambiguous_1')).toBeVisible();
    await expect(page.getByTestId('legacy-status-card_new_1')).toHaveText('unmatched');
    await expect(page.getByTestId('legacy-card-checkbox-card_new_1')).toBeEnabled();
    await expect(page.getByTestId('legacy-card-checkbox-card_match_1')).toBeDisabled();
    await expect(page.getByTestId('legacy-migrate-selected')).toContainText('迁移所选 0 张');

    const reparseItem = page.getByTestId('reparse-item-draft_1');
    await reparseItem.scrollIntoViewIfNeeded();
    await expect(reparseItem).toBeVisible();
    await expect(page.getByTestId('reparse-summary')).toContainText('job job_fixture · v4');
    await expect(page.getByTestId('reparse-status-draft_1')).toHaveText('changed');
    await expect(page.getByTestId('reparse-item-draft_2')).toBeVisible();
    await expect(page.getByTestId('reparse-action-draft_1')).toBeVisible();
    const resolveReparse = page.getByTestId('reparse-resolve');
    await resolveReparse.scrollIntoViewIfNeeded();
    await expect(resolveReparse).toBeInViewport();

    const noHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(noHorizontalOverflow).toBe(true);

    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(width + 1);
    expect(
      await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/deepstudent-import-fix-audit-${width}.png` });
  });
}
