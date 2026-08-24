import { describe, expect, it } from 'vitest';

import {
  loadPdfViewState,
  normalizePdfViewState,
  pdfViewStateKey,
  savePdfViewState,
} from '../pdfViewState';

function createFakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

describe('pdf view state persistence', () => {
  it('round-trips zoom/viewMode/coverOffset per resource path', () => {
    const storage = createFakeStorage();
    savePdfViewState(
      '/高考复习/tb_1',
      { zoomMode: 'custom', scale: 1.5, viewMode: 'dual', coverOffset: true },
      storage,
    );
    expect(loadPdfViewState('/高考复习/tb_1', storage)).toEqual({
      zoomMode: 'custom',
      scale: 1.5,
      viewMode: 'dual',
      coverOffset: true,
    });
    // 其它文档互不影响
    expect(loadPdfViewState('/高考复习/tb_2', storage)).toEqual({});
    expect(storage.map.has(pdfViewStateKey('/高考复习/tb_1'))).toBe(true);
  });

  it('returns empty state without a resource path or storage', () => {
    const storage = createFakeStorage();
    expect(loadPdfViewState(undefined, storage)).toEqual({});
    expect(loadPdfViewState('/tb_1', undefined)).toEqual({});
    savePdfViewState(undefined, { viewMode: 'dual' }, storage);
    expect(storage.map.size).toBe(0);
  });

  it('recovers from corrupted JSON payloads', () => {
    const storage = createFakeStorage();
    storage.setItem(pdfViewStateKey('/tb_1'), '{not json');
    expect(loadPdfViewState('/tb_1', storage)).toEqual({});
  });

  it('drops invalid fields independently instead of discarding the payload', () => {
    expect(
      normalizePdfViewState({
        zoomMode: 'bogus',
        scale: 1.25,
        viewMode: 'dual',
        coverOffset: 'yes',
      }),
    ).toEqual({ scale: 1.25, viewMode: 'dual' });
  });

  it('clamps persisted scale to the viewer range', () => {
    expect(normalizePdfViewState({ scale: 99 }).scale).toBe(3);
    expect(normalizePdfViewState({ scale: 0.01 }).scale).toBe(0.25);
    expect(normalizePdfViewState({ scale: Number.NaN })).toEqual({});
  });
});
