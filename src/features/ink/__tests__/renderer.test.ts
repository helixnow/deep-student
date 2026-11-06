import { describe, expect, it } from 'vitest';
import type { InkPage, InkPageRef } from '../types';
import { renderInkPage } from '../renderer';

const pageRef: InkPageRef = {
  page_id: 'page-1', width: 100, height: 80,
  background: { kind: 'blank', ruling: 'blank' }, page_blob_hash: 'page-hash',
};
const page: InkPage = { schema_version: 1, page_id: 'page-1', objects: [] };
const context = {
  save() {},
  setTransform() {},
  beginPath() {},
  rect() {},
  clip() {},
  fillRect() {},
  restore() {},
} as unknown as CanvasRenderingContext2D;
const canvas = { getContext: () => context } as unknown as HTMLCanvasElement;

describe('renderInkPage validation', () => {
  it('rejects a fractional max_pixels budget below one pixel', () => {
    expect(() => renderInkPage(canvas, pageRef, page, { max_pixels: 0.5 }))
      .toThrow('Pixel budget must be finite and positive');
  });

  it('rejects a non-finite max_pixels budget', () => {
    expect(() => renderInkPage(canvas, pageRef, page, { max_pixels: Number.NaN }))
      .toThrow('Pixel budget must be finite and positive');
  });

  it('rejects a page whose id does not match its reference', () => {
    expect(() => renderInkPage(canvas, pageRef, { ...page, page_id: 'different-page' }))
      .toThrow('Page and page reference ids must match');
  });

  it('rejects non-positive and non-finite render scales', () => {
    expect(() => renderInkPage(canvas, pageRef, page, { scale: 0 }))
      .toThrow('Render scale must be finite and positive');
    expect(() => renderInkPage(canvas, pageRef, page, { scale: Number.NaN }))
      .toThrow('Render scale must be finite and positive');
  });
});
