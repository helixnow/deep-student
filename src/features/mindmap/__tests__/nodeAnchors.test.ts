import { describe, expect, it, vi } from 'vitest';
import type { MindMapDocument, MindMapNode } from '../types';
import type { PdfSemanticAnchor, MediaSemanticAnchor, NoteSemanticAnchor } from '@/ui-sdk';
import {
  dedupeSemanticAnchors,
  formatMindMapSourcePill,
  getNodeExcerptMetaMap,
  MAX_EXCERPT_QUOTE_CHARS,
  normalizeTreeExcerptFields,
  selectNodeExcerptMeta,
} from '../utils/nodeAnchors';
import { deepCloneNode } from '../store/mindmapStoreHelpers';
import { createMindMapStore } from '../store/mindmapStore';
import { encodeMindMapClipboard, parseMindMapClipboardPayload } from '../utils/clipboardCodec';
import { importFromJson } from '../utils/importers';
import { exportToJson } from '../utils/exporters';
import '@/i18n';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async () => true),
  readTextFromClipboard: vi.fn(async () => ''),
}));

const pdfAnchor218: PdfSemanticAnchor = {
  kind: 'pdf',
  resourceId: 'file_calc_01',
  page: 218,
  rect: { x: 0.12, y: 0.34, w: 0.56, h: 0.08 },
  quote: 'If f is continuous on [a, b], then F is differentiable on (a, b).',
  label: 'Calculus Stewart',
};

const mediaAnchor1422: MediaSemanticAnchor = {
  kind: 'media',
  resourceId: 'media_lec_04',
  startMs: (14 * 60 + 22) * 1000,
  endMs: (14 * 60 + 38) * 1000,
  quote: 'Notice how the Jacobian determinant scales local area.',
};

const mediaAnchorHour: MediaSemanticAnchor = {
  kind: 'media',
  resourceId: 'media_lec_04',
  startMs: (1 * 3600 + 4 * 60 + 5) * 1000,
};

const noteAnchor: NoteSemanticAnchor = {
  kind: 'note',
  resourceId: 'note_summary_01',
  blockId: 'blk_9f8a',
  headingText: 'Fundamental Theorem',
};

describe('nodeAnchors', () => {
  it('formats Mineral Celadon source pills for pdf, media, and note anchors', () => {
    expect(formatMindMapSourcePill(pdfAnchor218)).toBe('P.218');
    expect(formatMindMapSourcePill(mediaAnchor1422)).toBe('14:22');
    expect(formatMindMapSourcePill(mediaAnchorHour)).toBe('01:04:05');
    expect(formatMindMapSourcePill(noteAnchor)).toBe('#blk_9f8a');
  });

  it('deduplicates semantic anchors by canonical URI while preserving order', () => {
    const duplicatePdf: PdfSemanticAnchor = { ...pdfAnchor218 };
    const otherPagePdf: PdfSemanticAnchor = { ...pdfAnchor218, page: 219 };

    const merged = dedupeSemanticAnchors(
      [pdfAnchor218, mediaAnchor1422],
      [duplicatePdf, otherPagePdf, noteAnchor],
    );

    expect(merged).toHaveLength(4);
    expect(merged.map(formatMindMapSourcePill)).toEqual([
      'P.218',
      '14:22',
      'P.219',
      '#blk_9f8a',
    ]);
  });

  it('caches getNodeExcerptMetaMap by root reference and preserves structural-sharing node meta identity', () => {
    const plainLeaf: MindMapNode = { id: 'plain', text: 'Plain leaf', children: [] };
    const excerptBranch: MindMapNode = {
      id: 'ex_1',
      text: 'Fundamental Theorem',
      anchors: [pdfAnchor218],
      excerptQuote: 'Full theorem statement from page 218.',
      imageAssetId: 'img_0123456789abcdef',
      children: [],
    };
    const rootV1: MindMapNode = {
      id: 'root',
      text: 'Calculus',
      children: [plainLeaf, excerptBranch],
    };

    const map1 = getNodeExcerptMetaMap(rootV1);
    const map2 = getNodeExcerptMetaMap(rootV1);
    expect(map2).toBe(map1);
    expect(selectNodeExcerptMeta(rootV1, 'plain')).toBeNull();

    const metaV1 = selectNodeExcerptMeta(rootV1, 'ex_1');
    expect(metaV1).toEqual({
      anchors: [pdfAnchor218],
      excerptQuote: 'Full theorem statement from page 218.',
      imageAssetId: 'img_0123456789abcdef',
    });

    // Simulate immer structural sharing: root and plainLeaf change, excerptBranch object is reused
    const rootV2: MindMapNode = {
      ...rootV1,
      children: [{ ...plainLeaf, text: 'Edited plain leaf' }, excerptBranch],
    };
    const map3 = getNodeExcerptMetaMap(rootV2);
    expect(map3).not.toBe(map1);
    expect(selectNodeExcerptMeta(rootV2, 'ex_1')).toBe(metaV1);
  });

  it('keeps legacy MindMapDocument JSON clean and round-trips MN5 excerpt fields without noisy empty arrays', () => {
    const legacyDoc: MindMapDocument = {
      version: '1.0',
      root: {
        id: 'root',
        text: 'Legacy Map',
        children: [{ id: 'c1', text: 'Legacy Child', children: [] }],
      },
      meta: { createdAt: '2026-01-01T00:00:00.000Z' },
    };

    const importedLegacy = importFromJson(exportToJson(legacyDoc));
    expect('anchors' in importedLegacy.root).toBe(false);
    expect('excerptQuote' in importedLegacy.root).toBe(false);
    expect('imageAssetId' in importedLegacy.root).toBe(false);
    expect(exportToJson(importedLegacy)).not.toContain('"anchors"');

    const mn5DocRaw = {
      version: '1.0',
      root: {
        id: 'root',
        text: 'Study Map',
        anchors: [],
        excerptQuote: '   ',
        children: [
          {
            id: 'n_excerpt',
            text: 'FTC Part 1',
            anchors: [pdfAnchor218, { kind: 'invalid_kind' }],
            excerptQuote: `  ${'A'.repeat(MAX_EXCERPT_QUOTE_CHARS + 50)}  `,
            imageAssetId: ' img_abc123 ',
            children: [],
          },
        ],
      },
      meta: { createdAt: '2026-01-01T00:00:00.000Z' },
    };

    const importedMn5 = importFromJson(JSON.stringify(mn5DocRaw));
    expect('anchors' in importedMn5.root).toBe(false);
    expect('excerptQuote' in importedMn5.root).toBe(false);

    const child = importedMn5.root.children[0];
    expect(child.anchors).toHaveLength(1);
    expect(child.anchors?.[0]).toMatchObject({ kind: 'pdf', resourceId: 'file_calc_01', page: 218 });
    expect(child.excerptQuote).toHaveLength(MAX_EXCERPT_QUOTE_CHARS);
    expect(child.imageAssetId).toBe('img_abc123');

    // Deep clone + clipboard structured codec preserve MN5 fields
    const cloned = deepCloneNode(child);
    expect(cloned).toEqual(child);
    expect(cloned.anchors).not.toBe(child.anchors);

    const encoded = encodeMindMapClipboard([child]);
    expect(encoded).not.toBeNull();
    const parsedClipboard = parseMindMapClipboardPayload(encoded!.payload);
    expect(parsedClipboard?.nodes[0].anchors).toEqual(child.anchors);
    expect(parsedClipboard?.nodes[0].excerptQuote).toBe(child.excerptQuote);
    expect(parsedClipboard?.nodes[0].imageAssetId).toBe('img_abc123');

    // Store updateNode supports null clearing on excerpt fields
    const store = createMindMapStore();
    store.setState({ document: importedMn5 });
    store.getState().updateNode('n_excerpt', {
      anchors: null,
      excerptQuote: null,
      imageAssetId: null,
    });
    const cleared = store.getState().document.root.children[0];
    expect('anchors' in cleared).toBe(false);
    expect('excerptQuote' in cleared).toBe(false);
    expect('imageAssetId' in cleared).toBe(false);

    // normalizeTreeExcerptFields strips empty arrays in place
    const noisy: MindMapNode = { id: 'x', text: 'x', anchors: [], excerptQuote: '', children: [] };
    normalizeTreeExcerptFields(noisy);
    expect('anchors' in noisy).toBe(false);
    expect('excerptQuote' in noisy).toBe(false);
  });
});
