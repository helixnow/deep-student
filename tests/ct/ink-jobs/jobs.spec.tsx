import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { InkJobsHarness } from './InkJobsHarness';

test('global prepare job converts the trusted source bytes and returns only staged PNG page metadata', async ({ mount }) => {
  const component = await mount(<InkJobsHarness mode="prepare" />);
  await expect(component.getByTestId('ink-job-listeners')).toHaveText('1');
  await component.getByTestId('ink-job-ready').click();
  await expect(component.getByTestId('ink-job-status')).toHaveText('done');
  const response = await component.evaluate(() => JSON.parse(document.querySelector('[data-testid="ink-job-result"]')?.textContent ?? 'null'));
  expect(response).toMatchObject({
    request_id: 'job-prepare-ct-1', operation_id: 'prepare-job-ct-1', kind: 'prepare',
    value: { kind: 'prepared', converter_version: 'browser-imagebitmap-v1;png-pages-v1;max-edge-2048', pages: [{ width_px: 64, height_px: 48 }] },
  });
  expect(response.value.pages[0].staged_upload_id).toBeTruthy();
  expect(response.value).not.toHaveProperty('manifest');
  const bytes = await component.evaluate(() => {
    const output = JSON.parse(document.querySelector('[data-testid="ink-job-bytes"]')?.textContent ?? '{}');
    return output[Object.keys(output)[0]];
  });
  expect(bytes.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const dimensions = await component.evaluate(async (_element, imageBytes: number[]) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }));
    const result = [bitmap.width, bitmap.height];
    bitmap.close();
    return result;
  }, bytes);
  expect(dimensions).toEqual([64, 48]);
});

test('global export job uses the frozen background and annotations then stages actual PNG bytes', async ({ mount }) => {
  const component = await mount(<InkJobsHarness mode="export" />);
  await component.getByTestId('ink-job-ready').click();
  await expect(component.getByTestId('ink-job-status')).toHaveText('done');
  const response = await component.evaluate(() => JSON.parse(document.querySelector('[data-testid="ink-job-result"]')?.textContent ?? 'null'));
  expect(response).toMatchObject({
    request_id: 'job-export-ct-1', operation_id: 'export-job-ct-1', kind: 'export',
    value: { kind: 'exported', staged_upload_id: 'ink-job-upload-1' },
  });
  expect(response.value).not.toHaveProperty('file_id');
  const bytes = await component.evaluate(() => {
    const output = JSON.parse(document.querySelector('[data-testid="ink-job-bytes"]')?.textContent ?? '{}');
    return output['ink-job-upload-1'];
  });
  expect(bytes.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const pixels = await component.evaluate(async (_element, imageBytes: number[]) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    const background = Array.from(context.getImageData(4, 4, 1, 1).data);
    const ink = Array.from(context.getImageData(12, 10, 1, 1).data);
    bitmap.close();
    return { dimensions: [canvas.width, canvas.height], background, ink };
  }, bytes);
  expect(pixels.dimensions).toEqual([64, 48]);
  expect(pixels.background).toEqual([20, 80, 204, 255]);
  expect(pixels.ink[0]).toBeGreaterThan(150);
});
