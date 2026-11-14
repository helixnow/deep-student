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
  module: 'repository/refs.ts',
  splitIn: 'dbb1ef08',
  preSplit: [
    'escapeXmlAttr', 'escapeXmlContent', 'extractFileTextWithStrategy', 'getAttachmentType', 'getEssaySessionContent',
    'getExamMultimodalBlocks', 'getExtractedText', 'getFileMultimodalBlocks', 'getFilePreviewRow', 'getFolderRefCount',
    'getFolderRefs', 'getImageOcrText', 'getOcrPagesText', 'getRawResourceContent', 'getResourcePath', 'getResourceRef',
    'getResourceRefCount', 'getResourceTitle', 'getSourceIdType', 'joinOcrPagesText', 'parseOcrPagesJson',
    'qualifyTitleExpr', 'resolveImageInjectModes', 'resolvePdfInjectModes', 'resolveSourceIdByResourceId',
    'resourceExists', 'selectExtractedText',
  ],
  addedSince: [],
  load: () => import('../repository/refs.ts'),
}];

describe('split files keep exporting their pre-split surface', () => {
  it.each(CASES)('$module (split in $splitIn)', async ({ preSplit, addedSince, load }) => {
    expect(Object.keys(await load()).sort()).toEqual([...preSplit, ...addedSince].sort());
  });
});
