import { describe, expect, it } from 'vitest';

import {
  loadPdfViewState,
  normalizePdfViewState,
  pdfViewStateKey,
  resolvePdfViewStateOnSwitch,
  savePdfViewState,
  sweepPdfViewStates,
} from '../pdfViewState';

function createFakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
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

  it('keeps savedAt as storage metadata invisible to loaded view state', () => {
    const storage = createFakeStorage();
    savePdfViewState('/tb_1', { viewMode: 'dual' }, storage, 1000);
    const raw = storage.map.get(pdfViewStateKey('/tb_1'));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string).savedAt).toBe(1000);
    // 读取路径丢弃 savedAt：viewer 只见视图字段
    expect(loadPdfViewState('/tb_1', storage)).toEqual({ viewMode: 'dual' });
  });
});

describe('resolvePdfViewStateOnSwitch', () => {
  it('overrides defaults with persisted fields and falls back per-field', () => {
    expect(
      resolvePdfViewStateOnSwitch(
        { zoomMode: 'fitWidth', scale: 1, viewMode: 'single' },
        { zoomMode: 'custom', scale: 1.5 },
      ),
    ).toEqual({ zoomMode: 'custom', scale: 1.5, viewMode: 'single', coverOffset: false });
  });

  it('resets coverOffset to false when neither side specifies it', () => {
    expect(resolvePdfViewStateOnSwitch({}, {}).coverOffset).toBe(false);
  });
});

describe('sweepPdfViewStates', () => {
  it('does nothing while under the cap', () => {
    const storage = createFakeStorage();
    savePdfViewState('/tb_1', {}, storage, 1);
    savePdfViewState('/tb_2', {}, storage, 2);
    expect(sweepPdfViewStates({ maxEntries: 2, storage })).toBe(0);
    expect(storage.map.size).toBe(2);
  });

  it('evicts the oldest entries by savedAt beyond the cap', () => {
    const storage = createFakeStorage();
    savePdfViewState('/tb_old', {}, storage, 100);
    savePdfViewState('/tb_mid', {}, storage, 200);
    savePdfViewState('/tb_new', {}, storage, 300);
    expect(sweepPdfViewStates({ maxEntries: 1, storage })).toBe(2);
    expect(storage.map.has(pdfViewStateKey('/tb_new'))).toBe(true);
    expect(storage.map.has(pdfViewStateKey('/tb_old'))).toBe(false);
    expect(storage.map.has(pdfViewStateKey('/tb_mid'))).toBe(false);
  });

  it('treats corrupted or legacy payloads (no savedAt) as oldest', () => {
    const storage = createFakeStorage();
    storage.setItem(pdfViewStateKey('/tb_corrupt'), '{not json');
    storage.setItem(pdfViewStateKey('/tb_legacy'), JSON.stringify({ viewMode: 'dual' }));
    savePdfViewState('/tb_fresh', {}, storage, 500);
    expect(sweepPdfViewStates({ maxEntries: 1, storage })).toBe(2);
    expect(storage.map.has(pdfViewStateKey('/tb_fresh'))).toBe(true);
  });

  it('never evicts the currently open document and ignores foreign keys', () => {
    const storage = createFakeStorage();
    storage.setItem('epub-reader:abc', '{}');
    savePdfViewState('/tb_current', {}, storage, 1);
    savePdfViewState('/tb_other', {}, storage, 999);
    expect(
      sweepPdfViewStates({ maxEntries: 1, keepResourcePath: '/tb_current', storage }),
    ).toBe(0);
    // /tb_current 受保护后剩 1 条 pdf-viewstate 条目，未超上限；异前缀 key 不动
    expect(storage.map.has(pdfViewStateKey('/tb_current'))).toBe(true);
    expect(storage.map.has('epub-reader:abc')).toBe(true);
  });
});
