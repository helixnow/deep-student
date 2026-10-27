import React from 'react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/experimental-ct-react';
import { PaperExportHarness } from './PaperExportHarness';

test('generates a real PDF with Chinese, formulas and editable DOCX blocks', async ({ mount, page }) => {
  test.setTimeout(90000);
  const component = await mount(<PaperExportHarness />);
  await component.getByRole('button').click();
  await expect(component.getByRole('button', { name: 'done', exact: true })).toBeVisible({ timeout: 60000 });
  const result = await page.evaluate(() => (window as unknown as { __PAPER_EXPORT_QA__: { pdf: number[]; blocks: unknown[]; markdown: string } }).__PAPER_EXPORT_QA__);
  expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-');
  expect(result.markdown).toContain('data:image/png;base64,');
  expect(result.markdown).not.toContain('attachment://');
  const out = path.resolve('.local-work/verification/practice-20261027');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'sample.pdf'), Buffer.from(result.pdf));
  await fs.writeFile(path.join(out, 'sample-blocks.json'), JSON.stringify(result.blocks));
});
