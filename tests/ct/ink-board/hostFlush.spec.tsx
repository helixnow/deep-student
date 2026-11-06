import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { InkBoardCtWindowBridge } from './InkBoardEditorHarness';
import { InkBoardEditorHarness } from './InkBoardEditorHarness';
import { INK_BOARD_CT_BASE_OBJECT_ID } from './fixtures';

interface BridgeWindow extends Window {
  __INK_BOARD_CT__?: InkBoardCtWindowBridge;
}

test('host flush saves an unlifted final stroke journal-first and reopens it without a duplicate', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="host-flush-active-stroke" />);
  const workspace = page.locator('[data-ink-workspace-page]');
  await expect(workspace.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
  const canvas = workspace.getByTestId('ink-board-canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board canvas has no visible bounds.');

  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 90, { steps: 5 });
  const saved = await page.evaluate(async () => {
    const bridge = (window as BridgeWindow).__INK_BOARD_CT__;
    if (!bridge) throw new Error('Missing ink board CT bridge.');
    const result = await bridge.flush();
    return { result, state: bridge.getState(), draft: await bridge.readDraft() };
  });

  expect(saved.result).toEqual({ ok: true });
  expect(saved.state.saveChunkRequests).toHaveLength(1);
  const stroke = saved.state.objects.find((object) => object.id !== INK_BOARD_CT_BASE_OBJECT_ID);
  expect(stroke?.content.kind).toBe('stroke');
  if (!stroke || stroke.content.kind !== 'stroke') throw new Error('Host flush dropped the active stroke.');
  expect(stroke.content.samples.length).toBeGreaterThan(1);
  expect(saved.state.journalAtCas[0]?.changed.some((chunk) => chunk.objects.some((object) => object.id === stroke.id))).toBe(true);
  expect(saved.draft).toBeUndefined();

  await page.mouse.up();
  const repeated = await page.evaluate(async () => {
    const bridge = (window as BridgeWindow).__INK_BOARD_CT__;
    if (!bridge) throw new Error('Missing ink board CT bridge.');
    return { result: await bridge.flush(), state: bridge.getState() };
  });
  expect(repeated.result).toEqual({ ok: true });
  expect(repeated.state.saveChunkRequests).toHaveLength(1);
  expect(repeated.state.objects.filter((object) => object.id === stroke.id)).toHaveLength(1);

  await workspace.locator('header').getByRole('button').click();
  await expect(workspace).toHaveCount(0);
  await page.getByTestId('ink-board-ct-unmount').click();
  await expect(page.getByTestId('ink-board-ct-remount')).toBeEnabled();
  await page.getByTestId('ink-board-ct-remount').click();
  await expect(workspace.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
  await expect(workspace.getByTestId('ink-board-editor')).toHaveAttribute('data-loaded-chunks', /[1-9]/);
  const reopened = await page.evaluate(() => (window as BridgeWindow).__INK_BOARD_CT__!.getState());
  expect(reopened.objects.find((object) => object.id === stroke.id)).toEqual(stroke);
});
