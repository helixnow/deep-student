import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator } from '@playwright/test';
import { InkRenderBridgeHarness } from './InkRenderBridgeHarness';
import {
  renderBridgeBoardChunks,
  renderBridgeBoardCrop,
  renderBridgeBoardLongEdge,
  renderBridgeBoardOutput,
  renderBridgeBoardPixelProbes,
  renderBridgeBoardSurface,
} from './renderBridgeBoardFixture';

interface BridgeFailure {
  code?: string;
  message?: string;
  stack?: string;
}

interface BridgeState {
  request?: Record<string, unknown>;
  result?: Record<string, unknown>;
  pngBytes?: number[];
  failure?: BridgeFailure;
}

interface InvokeCall {
  command: string;
  payload?: Record<string, unknown>;
}

const bridgeState = (component: Locator) =>
  component.evaluate(() => {
    const state = (window as unknown as { __INK_RENDER_CT__?: BridgeState }).__INK_RENDER_CT__;
    return state;
  });

const invokeCalls = (component: Locator) =>
  component.evaluate(() => {
    const calls = (window as unknown as { __CT_INVOKE_CALLS__?: InvokeCall[] }).__CT_INVOKE_CALLS__;
    return calls ?? [];
  });

const waitForBridgeOutcome = async (component: Locator) => {
  await expect.poll(() => component.evaluate(() => {
    const state = (window as unknown as { __INK_RENDER_CT__?: BridgeState }).__INK_RENDER_CT__;
    return Boolean(state?.result || state?.failure);
  })).toBe(true);
};

const readStagedCanvas = (component: Locator) =>
  component.evaluate(async (_element, probes) => {
    const state = (window as unknown as { __INK_RENDER_CT__?: BridgeState }).__INK_RENDER_CT__;
    if (!state?.pngBytes?.length) throw new Error('staged PNG bytes are missing');
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(state.pngBytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    const read = (point: { x: number; y: number }) => Array.from(context.getImageData(point.x, point.y, 1, 1).data);
    const pixels = {
      background: read(probes.background),
      negativeOriginStroke: read(probes.negativeOriginStroke),
      aiRect: read(probes.aiRect),
      highlighter: read(probes.highlighter),
    };
    bitmap.close();
    return { width: canvas.width, height: canvas.height, pngBytes: state.pngBytes.length, pixels };
  }, renderBridgeBoardPixelProbes);

const expectHighlighterGreen = (pixel: number[]) => {
  expect(pixel[1]).toBe(255);
  expect(pixel[0]).toBe(pixel[2]);
  expect(pixel[0]).toBeGreaterThanOrEqual(120);
  expect(pixel[0]).toBeLessThanOrEqual(135);
  expect(pixel[3]).toBe(255);
};

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

test('renders a frozen signed board request in the editorless bridge with crop-relative stroke, highlighter and AI pixels', async ({ mount }) => {
  const component = await mount(<InkRenderBridgeHarness />);
  expect(await component.getByTestId('ink-page-canvas').count()).toBe(0);
  await component.getByTestId('ink-render-bridge-board-valid-request').click();
  await waitForBridgeOutcome(component);

  const state = await bridgeState(component);
  expect(state?.failure, JSON.stringify(state?.failure ?? null)).toBeUndefined();
  expect(state?.request).toMatchObject({
    request_id: 'request-ct-board-valid',
    render_id: 'render-ct-board-valid',
    document_id: 'document-ct-board-1',
    revision: 'revision-board-frozen-3',
    page_ref: null,
    page: null,
    crop: null,
    long_edge: renderBridgeBoardLongEdge,
    board: {
      schema_version: 2,
      surface: renderBridgeBoardSurface,
      crop: renderBridgeBoardCrop,
      chunks: renderBridgeBoardChunks,
    },
  });
  expect(state?.result).toMatchObject({
    result: {
      request_id: 'request-ct-board-valid',
      render_id: 'render-ct-board-valid',
      staged_upload_id: 'render-bridge-upload',
      width_px: renderBridgeBoardOutput.width,
      height_px: renderBridgeBoardOutput.height,
    },
  });

  const artifact = await readStagedCanvas(component);
  expect([artifact.width, artifact.height]).toEqual([renderBridgeBoardOutput.width, renderBridgeBoardOutput.height]);
  expect(artifact.width / artifact.height)
    .toBeCloseTo(renderBridgeBoardCrop.width / renderBridgeBoardCrop.height, 6);
  expect(artifact.pixels.background).toEqual([255, 255, 255, 255]);
  expect(artifact.pixels.negativeOriginStroke).toEqual([0, 0, 0, 255]);
  expect(artifact.pixels.aiRect).toEqual([255, 0, 0, 255]);
  expectHighlighterGreen(artifact.pixels.highlighter);

  const calls = await invokeCalls(component);
  expect(calls.filter((call) => call.command === 'vfs_get_blob_base64')).toEqual([]);
  expect(calls.some((call) => call.command === 'staged_upload_begin')).toBe(true);
  expect(calls.some((call) => call.command === 'staged_upload_append')).toBe(true);
});

test('stages a same-crop blank board control with identical dimensions and white pixels', async ({ mount }) => {
  const component = await mount(<InkRenderBridgeHarness />);
  await component.getByTestId('ink-render-bridge-board-blank-request').click();
  await waitForBridgeOutcome(component);

  const state = await bridgeState(component);
  expect(state?.failure, JSON.stringify(state?.failure ?? null)).toBeUndefined();
  expect(state?.request).toMatchObject({
    request_id: 'request-ct-board-blank',
    page_ref: null,
    page: null,
    crop: null,
    board: {
      schema_version: 2,
      surface: renderBridgeBoardSurface,
      crop: renderBridgeBoardCrop,
      chunks: [],
    },
  });

  const artifact = await readStagedCanvas(component);
  expect([artifact.width, artifact.height]).toEqual([renderBridgeBoardOutput.width, renderBridgeBoardOutput.height]);
  expect(artifact.pixels.background).toEqual([255, 255, 255, 255]);
  expect(artifact.pixels.negativeOriginStroke).toEqual([255, 255, 255, 255]);
  expect(artifact.pixels.aiRect).toEqual([255, 255, 255, 255]);
  expect(artifact.pixels.highlighter).toEqual([255, 255, 255, 255]);

  const calls = await invokeCalls(component);
  expect(calls.filter((call) => call.command === 'vfs_get_blob_base64')).toEqual([]);
  expect(calls.some((call) => call.command === 'staged_upload_begin')).toBe(true);
});

test('rejects mixed board/page mode and invalid board payloads with typed errors and no staged upload', async ({ mount }) => {
  const component = await mount(<InkRenderBridgeHarness />);
  const invalidCases = [
    {
      label: 'board plus page mixed mode',
      testId: 'ink-render-bridge-board-mixed-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'non-finite board crop',
      testId: 'ink-render-bridge-board-nonfinite-crop-request',
      codes: ['INVALID_ARGUMENT', 'LIMIT_EXCEEDED'],
    },
    {
      label: 'world-overflow board crop',
      testId: 'ink-render-bridge-board-world-overflow-crop-request',
      codes: ['INVALID_ARGUMENT', 'LIMIT_EXCEEDED'],
    },
    {
      label: 'missing board chunks',
      testId: 'ink-render-bridge-board-missing-chunks-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'duplicate board chunk id',
      testId: 'ink-render-bridge-board-duplicate-chunk-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'negative board object z-index',
      testId: 'ink-render-bridge-board-negative-object-z-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'duplicate z-index across chunks',
      testId: 'ink-render-bridge-board-duplicate-z-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'unknown payload field',
      testId: 'ink-render-bridge-board-unknown-payload-field-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'unknown surface field',
      testId: 'ink-render-bridge-board-unknown-surface-field-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'unknown chunk field',
      testId: 'ink-render-bridge-board-unknown-chunk-field-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'unknown object content field',
      testId: 'ink-render-bridge-board-unknown-content-field-request',
      codes: ['INVALID_ARGUMENT'],
    },
    {
      label: 'long edge over 2048',
      testId: 'ink-render-bridge-board-long-edge-request',
      codes: ['LIMIT_EXCEEDED'],
    },
  ];

  for (const invalid of invalidCases) {
    await component.getByTestId(invalid.testId).click();
    await waitForBridgeOutcome(component);
    const state = await bridgeState(component);
    const code = state?.failure?.code ?? 'NO_TYPED_FAILURE';
    expect.soft(
      invalid.codes,
      `${invalid.label}: got ${code} (${state?.failure?.message ?? 'no message'})`,
    ).toContain(code);
    expect.soft((state?.pngBytes ?? []).length, `${invalid.label}: staged PNG bytes`).toBe(0);
  }

  const calls = await invokeCalls(component);
  const stagedCalls = calls.filter((call) => call.command === 'staged_upload_begin' || call.command === 'staged_upload_append');
  expect(stagedCalls.length, 'invalid board payloads must not reach staged upload').toBe(0);
  expect(calls.filter((call) => call.command === 'vfs_get_blob_base64')).toEqual([]);
});
