import { describe, expect, it } from 'vitest';

interface SplitCase {
  module: string;
  splitIn: string;
  /** Runtime export keys of the file at `splitIn^`. */
  preSplit: readonly string[];
  addedSince: readonly string[];
  load: () => Promise<Record<string, unknown>>;
}

const CASES: readonly SplitCase[] = [{
  module: 'src/pdf-runtime.ts',
  splitIn: '0f11c3a1',
  preSplit: ['NativePdfStageRuntime', 'defaultPdfOcrConfig', 'parsePreviewJson'],
  addedSince: [],
  load: () => import('../src/pdf-runtime.ts'),
}, {
  module: 'src/full-indexing.ts',
  splitIn: '0413204c',
  preSplit: ['UnsupportedIndexResourceTypeError', 'VfsFullIndexingService'],
  addedSince: [],
  load: () => import('../src/full-indexing.ts'),
}, {
  module: 'src/multimodal-service.ts',
  splitIn: '417de4db',
  preSplit: ['MM_INDEX_PROGRESS_EVENT', 'VfsMultimodalService'],
  addedSince: [],
  load: () => import('../src/multimodal-service.ts'),
}, {
  module: 'src/lance-store.ts',
  splitIn: 'd1d90f70',
  preSplit: [
    'ANN_INDEX_VERSION', 'MIN_ROWS_FOR_ANN_INDEX', 'OPTIMIZE_MIN_INTERVAL_SECS', 'VFS_FTS_VERSION', 'VFS_LANCE_TABLE_PREFIX',
    'VFS_MUTATION_LOCK', 'VfsLanceStore', 'VfsStoreError', 'invalidArgument', 'invalidState', 'notFound', 'other',
  ],
  addedSince: [],
  load: () => import('../src/lance-store.ts'),
}];

describe('split files keep exporting their pre-split surface', () => {
  it.each(CASES)('$module (split in $splitIn)', async ({ preSplit, addedSince, load }) => {
    expect(Object.keys(await load()).sort()).toEqual([...preSplit, ...addedSince].sort());
  });
});
