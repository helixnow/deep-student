import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { InkRenderBridgeHarness } from './InkRenderBridgeHarness';

test('renders a frozen request without an editor and stages the real PNG bytes', async ({ mount }) => {
  const component = await mount(<InkRenderBridgeHarness />);
  expect(await component.getByTestId('ink-page-canvas').count()).toBe(0);
  await component.getByTestId('ink-render-bridge-image-request').click();

  await expect.poll(() => component.evaluate(() => {
    const state = (window as Window & { __INK_RENDER_CT__?: { result?: unknown; failure?: unknown } }).__INK_RENDER_CT__;
    return Boolean(state?.result || state?.failure);
  })).toBe(true);
  const failure = await component.evaluate(() =>
    (window as Window & { __INK_RENDER_CT__?: { failure?: unknown } }).__INK_RENDER_CT__?.failure,
  );
  expect(failure === undefined, JSON.stringify(failure ?? null)).toBe(true);

  const artifact = await component.evaluate(async () => {
    const state = (window as Window & {
      __INK_RENDER_CT__?: { result?: Record<string, unknown>; pngBytes?: number[] };
    }).__INK_RENDER_CT__;
    if (!state?.result || !state.pngBytes?.length) throw new Error('render result or staged PNG missing');
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(state.pngBytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    const background = Array.from(context.getImageData(4, 4, 1, 1).data);
    const annotation = Array.from(context.getImageData(20, 14, 1, 1).data);
    bitmap.close();
    return { result: state.result, width: canvas.width, height: canvas.height, background, annotation };
  });

  expect(artifact.result).toMatchObject({
    request: {
      request_id: 'request-ct-image-1',
      render_id: 'render-ct-image-1',
      document_id: 'document-ct-1',
      revision: 'revision-frozen-7',
      page_ref: { page_id: 'render-bridge-page', page_blob_hash: 'frozen-page-hash' },
      page: { page_id: 'render-bridge-page' },
    },
    result: {
      request_id: 'request-ct-image-1',
      render_id: 'render-ct-image-1',
      staged_upload_id: 'render-bridge-upload',
      width_px: 64,
      height_px: 48,
    },
  });
  expect([artifact.width, artifact.height]).toEqual([64, 48]);
  expect(artifact.background).toEqual([221, 221, 221, 255]);
  expect(artifact.annotation).toEqual([255, 0, 0, 255]);
});

test('renders prepared PDF-page PNG bytes in the editorless bridge and keeps normalized source highlight under Ink', async ({ mount }) => {
  const component = await mount(<InkRenderBridgeHarness />);
  expect(await component.getByTestId('ink-page-canvas').count()).toBe(0);
  await component.getByTestId('ink-render-bridge-pdf-request').click();

  await expect.poll(() => component.evaluate(() => {
    const state = (window as Window & { __INK_RENDER_CT__?: { result?: unknown; failure?: unknown } }).__INK_RENDER_CT__;
    return Boolean(state?.result || state?.failure);
  })).toBe(true);
  const failure = await component.evaluate(() =>
    (window as Window & { __INK_RENDER_CT__?: { failure?: unknown } }).__INK_RENDER_CT__?.failure,
  );
  expect(failure === undefined, JSON.stringify(failure ?? null)).toBe(true);

  const pixels = await component.evaluate(async () => {
    const state = (window as Window & {
      __INK_RENDER_CT__?: { pngBytes?: number[] };
    }).__INK_RENDER_CT__;
    if (!state?.pngBytes?.length) throw new Error('prepared PNG snapshot was not staged');
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(state.pngBytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    const background = Array.from(context.getImageData(5, 5, 1, 1).data);
    const sourceOnly = Array.from(context.getImageData(16, 20, 1, 1).data);
    const inkOverSource = Array.from(context.getImageData(20, 20, 1, 1).data);
    bitmap.close();
    return { background, sourceOnly, inkOverSource, size: [canvas.width, canvas.height] };
  });
  expect(pixels.size).toEqual([120, 160]);
  expect(pixels.background).toEqual([221, 221, 221, 255]);
  expect(pixels.sourceOnly).toEqual([110, 110, 221, 255]);
  expect(pixels.inkOverSource).toEqual([255, 0, 0, 255]);
});
