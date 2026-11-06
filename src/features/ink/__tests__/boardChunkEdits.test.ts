/**
 * Contract: planBoardChunkEdits(manifest, loaded, incoming, { allowNew }) is
 * pure and returns { changed, previous } without hydrating unloaded chunks.
 */
import { describe, expect, it } from 'vitest';

import { planBoardChunkEdits } from '../boardChunkEdits';
import { visibleInkObjectBounds } from '../geometryPrimitives';
import {
  INK_BOARD_LIMITS,
  INK_BOARD_SCHEMA_VERSION,
  INK_LIMITS,
  type InkBoardBounds,
  type InkBoardChunk,
  type InkBoardChunkRef,
  type InkBoardManifest,
  type InkBoardObject,
  type InkRect,
  type InkSample,
} from '../types';

const MIB = 1024 * 1024;
const DOCUMENT_ID = 'ink_board_chunk_edits';
const PAGE_ID = 'board_page_chunk_edits';
const encoder = new TextEncoder();

const utf8Bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

const refBounds: InkBoardBounds = { x: -1000, y: -1000, width: 2000, height: 2000 };
const worldBounds: InkBoardBounds = {
  x: -10_000_000,
  y: -10_000_000,
  width: 20_000_000,
  height: 20_000_000,
};

interface ChunkCounts {
  objects?: number;
  samples?: number;
}

const chunkRef = (
  chunk_id: string,
  counts: ChunkCounts = {},
  byte_length = 1024,
): InkBoardChunkRef => ({
  chunk_id,
  blob_hash: `hash-${chunk_id}`,
  byte_length,
  object_count: counts.objects ?? 1,
  sample_count: counts.samples ?? 0,
  bounds: refBounds,
});

function makeManifest(chunks: InkBoardChunkRef[] = []): InkBoardManifest {
  return {
    schema_version: INK_BOARD_SCHEMA_VERSION,
    document_id: DOCUMENT_ID,
    revision: 'rev-1',
    title: 'Board',
    source: { kind: 'blank' },
    pages: [],
    surface: {
      kind: 'board',
      page_id: PAGE_ID,
      ruling: 'grid',
      bounds: worldBounds,
    },
    chunks,
  };
}

const chunk = (chunk_id: string, objects: InkBoardObject[]): InkBoardChunk => ({
  schema_version: INK_BOARD_SCHEMA_VERSION,
  chunk_id,
  objects,
});

const sampleCountOf = (planned: InkBoardChunk): number => planned.objects.reduce(
  (count, object) => count + (object.content.kind === 'stroke' ? object.content.samples.length : 0),
  0,
);

const refFromChunk = (planned: InkBoardChunk): InkBoardChunkRef => chunkRef(
  planned.chunk_id,
  { objects: planned.objects.length, samples: sampleCountOf(planned) },
  utf8Bytes(planned),
);

const textObject = (
  id: string,
  zIndex: number,
  text = 'x',
  rect: InkRect = { x: -9_900_000, y: -9_900_000, width: 10, height: 10 },
): InkBoardObject => ({
  id,
  author: 'user',
  created_at: 1,
  z_index: zIndex,
  content: {
    kind: 'text',
    rect,
    text,
    font_size: 12,
    color: '#000000',
  },
});

const strokeObject = (id: string, zIndex: number, samples: InkSample[]): InkBoardObject => ({
  id,
  author: 'user',
  created_at: 1,
  z_index: zIndex,
  content: {
    kind: 'stroke',
    samples,
    style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: true },
  },
});

const oneSampleStroke = (id: string, zIndex: number): InkBoardObject => strokeObject(id, zIndex, [
  { x: -9_900_000, y: -9_900_000, pressure: 0.5, elapsed_ms: 0 },
]);

const clone = <T>(value: T): T => structuredClone(value);

describe('planBoardChunkEdits', () => {
  it('packs 300 new objects into one chunk while preserving negative world coordinates', () => {
    const manifest = makeManifest();
    const loaded: InkBoardChunk[] = [];
    const incoming = Array.from({ length: 300 }, (_, index) => textObject(
      `new-${String(index).padStart(3, '0')}`,
      1000 + index,
      `n${index}`,
      { x: -9_900_000 + index * 10, y: -9_900_000 + index * 10, width: 8, height: 8 },
    ));
    const manifestBefore = clone(manifest);
    const loadedBefore = clone(loaded);
    const incomingBefore = clone(incoming);

    const result = planBoardChunkEdits(manifest, loaded, incoming, { allowNew: true });

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].schema_version).toBe(INK_BOARD_SCHEMA_VERSION);
    expect(result.changed[0].objects.map((object) => object.id))
      .toEqual(incoming.map((object) => object.id));
    // Deep equality also proves the signed coordinates were not clamped.
    expect(result.changed[0].objects[0].content).toEqual(incoming[0].content);
    expect(result.changed[0].objects[299].content).toEqual(incoming[299].content);
    expect(new Set(result.changed[0].objects.map((object) => object.z_index)).size).toBe(300);
    expect(result.previous).toEqual([{ chunk_id: result.changed[0].chunk_id }]);

    expect(manifest).toEqual(manifestBefore);
    expect(loaded).toEqual(loadedBefore);
    expect(incoming).toEqual(incomingBefore);
  });

  it('rejects aggregate object/sample limits from unloaded refs and preserves every input', () => {
    const sampleRefs = Array.from({ length: 20 }, (_, index) => chunkRef(
      `sample-unloaded-${index}`,
      { objects: 1, samples: INK_BOARD_LIMITS.chunk_samples_max },
      MIB,
    ));
    const sampleManifest = makeManifest(sampleRefs);
    const sampleIncoming = [oneSampleStroke('new-sample', 0)];
    const sampleManifestBefore = clone(sampleManifest);
    const sampleIncomingBefore = clone(sampleIncoming);

    expect(() => planBoardChunkEdits(
      sampleManifest,
      [],
      sampleIncoming,
      { allowNew: true },
    )).toThrow(/sample/i);
    expect(sampleManifest).toEqual(sampleManifestBefore);
    expect(sampleIncoming).toEqual(sampleIncomingBefore);

    const objectRefs = Array.from({ length: 10 }, (_, index) => chunkRef(
      `object-unloaded-${index}`,
      { objects: INK_BOARD_LIMITS.chunk_objects_max, samples: 1 },
      MIB,
    ));
    const objectManifest = makeManifest(objectRefs);
    const objectIncoming = [textObject('new-object', 20_000)];
    const objectManifestBefore = clone(objectManifest);
    const objectIncomingBefore = clone(objectIncoming);

    expect(() => planBoardChunkEdits(
      objectManifest,
      [],
      objectIncoming,
      { allowNew: true },
    )).toThrow(/object/i);
    expect(objectManifest).toEqual(objectManifestBefore);
    expect(objectIncoming).toEqual(objectIncomingBefore);
  });

  it('updates a loaded owner chunk and leaves unloaded refs untouched', () => {
    const manifest = makeManifest([
      chunkRef('chunk-a', { objects: 2, samples: 2 }),
      chunkRef('chunk-b', { objects: 1, samples: 100 }, 2048),
    ]);
    const original = chunk('chunk-a', [
      textObject('obj-a1', 0, 'old'),
      textObject('obj-a2', 1, 'peer'),
    ]);
    const loaded = [original];
    const updated = textObject('obj-a1', 0, 'updated');
    const incoming = [updated];
    const manifestBefore = clone(manifest);
    const originalBefore = clone(original);
    const loadedBefore = clone(loaded);
    const incomingBefore = clone(incoming);

    const result = planBoardChunkEdits(manifest, loaded, incoming, { allowNew: false });

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].chunk_id).toBe('chunk-a');
    expect(result.changed[0].objects).toHaveLength(2);
    expect(result.changed[0].objects.find((object) => object.id === 'obj-a1')?.content)
      .toEqual(updated.content);
    expect(result.changed[0].objects.find((object) => object.id === 'obj-a2')?.content)
      .toEqual(original.objects[1].content);
    expect(result.previous).toEqual([{ chunk_id: 'chunk-a', previous: original }]);
    expect(result.changed.some((entry) => entry.chunk_id === 'chunk-b')).toBe(false);
    expect(result.previous.some((entry) => entry.chunk_id === 'chunk-b')).toBe(false);

    expect(manifest).toEqual(manifestBefore);
    expect(original).toEqual(originalBefore);
    expect(loaded).toEqual(loadedBefore);
    expect(incoming).toEqual(incomingBefore);
  });

  it('rejects an unknown object id when allowNew is false without hydrating unloaded refs', () => {
    const manifest = makeManifest([
      chunkRef('chunk-unloaded', { objects: 1, samples: 0 }),
      chunkRef('chunk-loaded', { objects: 1, samples: 1 }),
    ]);
    const loadedOwner = chunk('chunk-loaded', [textObject('obj-loaded', 0)]);
    const loaded = [loadedOwner];
    // This id could exist inside chunk-unloaded, but the planner only knows the
    // loaded chunks and must not fetch it.
    const incoming = [textObject('obj-unloaded', 10, 'new')];
    const manifestBefore = clone(manifest);
    const loadedBefore = clone(loaded);
    const incomingBefore = clone(incoming);

    expect(() => planBoardChunkEdits(
      manifest,
      loaded,
      incoming,
      { allowNew: false },
    )).toThrow(/loaded|unknown|owner/i);

    expect(manifest).toEqual(manifestBefore);
    expect(loaded).toEqual(loadedBefore);
    expect(incoming).toEqual(incomingBefore);
  });

  it('atomically rejects one oversize stroke instead of splitting or partially applying it', () => {
    const manifest = makeManifest([chunkRef('chunk-huge', { objects: 1, samples: 0 })]);
    const original = chunk('chunk-huge', [textObject('obj-huge', 0, 'old')]);
    const loaded = [original];
    const samples: InkSample[] = Array.from(
      { length: INK_BOARD_LIMITS.chunk_samples_max },
      (_, index) => ({
        x: -1_234_567.123456789,
        y: 1_234_567.123456789,
        pressure: 0.123456789012345,
        elapsed_ms: 9_000_000_000_000_000 + index,
      }),
    );
    const oversized = strokeObject('obj-huge', 0, samples);
    const incoming = [oversized];
    const candidate = chunk('chunk-huge', [oversized]);
    const manifestBefore = clone(manifest);
    const originalBefore = clone(original);
    const loadedBefore = clone(loaded);
    const incomingBefore = clone(incoming);

    expect(utf8Bytes(candidate)).toBeGreaterThan(INK_BOARD_LIMITS.chunk_max_bytes);
    expect(() => planBoardChunkEdits(
      manifest,
      loaded,
      incoming,
      { allowNew: false },
    )).toThrow(/chunk|MiB|byte|limit/i);

    expect(manifest).toEqual(manifestBefore);
    expect(original).toEqual(originalBefore);
    expect(loaded).toEqual(loadedBefore);
    expect(incoming).toEqual(incomingBefore);
  });

  it('packs 10000-character text by exact UTF-8 bytes, not JS string length', () => {
    const manifest = makeManifest();
    const loaded: InkBoardChunk[] = [];
    const text = '\u4e2d'.repeat(INK_LIMITS.text_max_chars);
    const incoming = Array.from({ length: 500 }, (_, index) => textObject(
      `utf8-${index}`,
      2000 + index,
      text,
      { x: index, y: index, width: 10, height: 10 },
    ));
    const manifestBefore = clone(manifest);
    const loadedBefore = clone(loaded);
    const incomingBefore = clone(incoming);

    expect(text).toHaveLength(INK_LIMITS.text_max_chars);
    // A JS `.length` (or a fixed bytes-per-character) shortcut would fit this
    // into one chunk. Exact UTF-8 bytes require more than one chunk.
    expect(JSON.stringify(incoming).length).toBeLessThan(INK_BOARD_LIMITS.chunk_max_bytes);
    expect(utf8Bytes(incoming)).toBeGreaterThan(INK_BOARD_LIMITS.chunk_max_bytes);

    const result = planBoardChunkEdits(manifest, loaded, incoming, { allowNew: true });

    expect(result.changed).toHaveLength(2);
    expect(result.changed.reduce((count, entry) => count + entry.objects.length, 0)).toBe(500);
    expect(result.previous).toEqual(result.changed.map((entry) => ({ chunk_id: entry.chunk_id })));
    for (const planned of result.changed) {
      expect(utf8Bytes(planned)).toBeLessThanOrEqual(INK_BOARD_LIMITS.chunk_max_bytes);
      for (const object of planned.objects) {
        expect(object.content.kind).toBe('text');
        if (object.content.kind === 'text') {
          expect(object.content.text.length).toBe(INK_LIMITS.text_max_chars);
        }
      }
    }

    expect(manifest).toEqual(manifestBefore);
    expect(loaded).toEqual(loadedBefore);
    expect(incoming).toEqual(incomingBefore);
  });

  it('reuses a loaded chunk for single-object gestures instead of creating one chunk per gesture', () => {
    const initial = Array.from({ length: 300 }, (_, index) => textObject(
      `bulk-${String(index).padStart(3, '0')}`,
      1000 + index,
      `b${index}`,
      { x: -1000 + index, y: -1000 + index, width: 8, height: 8 },
    ));
    const first = planBoardChunkEdits(makeManifest(), [], initial, { allowNew: true });
    expect(first.changed).toHaveLength(1);
    const initialChunkId = first.changed[0].chunk_id;
    const chunks = new Map<string, InkBoardChunk>(
      first.changed.map((entry) => [entry.chunk_id, entry] as const),
    );

    const currentManifest = (): InkBoardManifest => makeManifest(
      [...chunks.values()].map(refFromChunk),
    );

    let manifest = currentManifest();
    for (let index = 0; index < 257; index += 1) {
      const incoming = [textObject(
        `append-${index}`,
        20_000 + index,
        `a${index}`,
        { x: index, y: index, width: 10, height: 10 },
      )];
      const result = planBoardChunkEdits(
        manifest,
        [...chunks.values()],
        incoming,
        { allowNew: true },
      );
      for (const planned of result.changed) chunks.set(planned.chunk_id, planned);
      manifest = currentManifest();
    }

    expect(chunks.size).toBe(1);
    expect(chunks.has(initialChunkId)).toBe(true);

    const remaining = [...chunks.values()].flatMap((entry) => entry.objects);
    expect(remaining).toHaveLength(557);
    const byId = new Map<string, InkBoardObject>(
      remaining.map((entry) => [entry.id, entry] as const),
    );
    for (const object of initial) expect(byId.get(object.id)).toEqual(object);
    for (let index = 0; index < 257; index += 1) {
      expect(byId.has(`append-${index}`)).toBe(true);
    }
  });

  it('rejects a thick rect whose visible footprint crosses the world boundary', () => {
    const object: InkBoardObject = {
      id: 'rect-world-edge',
      author: 'user',
      created_at: 1,
      z_index: 0,
      content: {
        kind: 'rect',
        rect: { x: 9_999_998, y: 0, width: 1, height: 1 },
        color: '#000000',
        width: 10,
      },
    };
    const footprint = visibleInkObjectBounds(object.content);
    if (!footprint) throw new Error('Expected a visible rect footprint.');
    expect(footprint.x + footprint.width).toBeGreaterThan(INK_BOARD_LIMITS.world_limit);

    expect(() => planBoardChunkEdits(makeManifest(), [], [object], { allowNew: true }))
      .toThrow(/world|bounds|limit/i);
  });

  it('rejects an arrow whose visible arrowhead crosses the world boundary', () => {
    const object: InkBoardObject = {
      id: 'arrow-world-edge',
      author: 'user',
      created_at: 1,
      z_index: 0,
      content: {
        kind: 'arrow',
        // The main line reaches exactly the edge; the backward-facing head of
        // this leftward arrow is what crosses it.
        from: { x: 9_999_999, y: 0 },
        to: { x: 9_999_995, y: 0 },
        color: '#000000',
        width: 2,
      },
    };
    const footprint = visibleInkObjectBounds(object.content);
    if (!footprint) throw new Error('Expected a visible arrow footprint.');
    if (object.content.kind !== 'arrow') throw new Error('Expected arrow content.');
    expect(Math.max(object.content.from.x, object.content.to.x) + object.content.width / 2)
      .toBeLessThanOrEqual(INK_BOARD_LIMITS.world_limit);
    expect(footprint.x + footprint.width).toBeGreaterThan(INK_BOARD_LIMITS.world_limit);

    expect(() => planBoardChunkEdits(makeManifest(), [], [object], { allowNew: true }))
      .toThrow(/world|bounds|limit/i);
  });

  it('accepts a pressure-0 stroke point half a world unit from the edge', () => {
    const object = strokeObject('stroke-edge-legal', 0, [
      { x: 9_999_999.5, y: 0, pressure: 0, elapsed_ms: 0 },
    ]);
    const visible = visibleInkObjectBounds(object.content);
    if (!visible) throw new Error('Expected a visible stroke footprint.');
    expect(visible.x + visible.width).toBeLessThanOrEqual(INK_BOARD_LIMITS.world_limit);

    expect(() => planBoardChunkEdits(makeManifest(), [], [object], { allowNew: true }))
      .not.toThrow();
  });

  it('accepts a rightward arrow whose endpoint is 1.5 units from the edge with width 2', () => {
    const object: InkBoardObject = {
      id: 'arrow-edge-legal',
      author: 'user',
      created_at: 1,
      z_index: 0,
      content: {
        kind: 'arrow',
        from: { x: 0, y: 0 },
        to: { x: 9_999_998.5, y: 0 },
        color: '#000000',
        width: 2,
      },
    };
    const visible = visibleInkObjectBounds(object.content);
    if (!visible) throw new Error('Expected a visible arrow footprint.');
    expect(visible.x + visible.width).toBeLessThanOrEqual(INK_BOARD_LIMITS.world_limit);

    expect(() => planBoardChunkEdits(makeManifest(), [], [object], { allowNew: true }))
      .not.toThrow();
  });

  it('rejects a 257th chunk while allowing the 256th', () => {
    const newObject = textObject('chunk-limit-new', 30_000, 'x', { x: 0, y: 0, width: 10, height: 10 });

    const nearLimit = Array.from({ length: 255 }, (_, index) => chunkRef(
      `chunk-limit-${index}`,
      { objects: 1, samples: 0 },
      1024,
    ));
    const allowed = planBoardChunkEdits(makeManifest(nearLimit), [], [newObject], { allowNew: true });
    expect(allowed.changed).toHaveLength(1);

    const overLimit = Array.from({ length: 256 }, (_, index) => chunkRef(
      `chunk-over-${index}`,
      { objects: 1, samples: 0 },
      1024,
    ));
    expect(() => planBoardChunkEdits(makeManifest(overLimit), [], [newObject], { allowNew: true }))
      .toThrow(/chunk/i);
  });

  it('enforces the final content byte limit without sample/object shortcuts', () => {
    const newObject = textObject('byte-limit-new', 30_001, 'x', { x: 0, y: 0, width: 10, height: 10 });

    const nearLimit = [
      ...Array.from({ length: 7 }, (_, index) => chunkRef(
        `byte-under-${index}`,
        { objects: 1, samples: 0 },
        INK_BOARD_LIMITS.chunk_max_bytes,
      )),
      chunkRef('byte-under-tail', { objects: 1, samples: 0 }, 7 * MIB),
    ];
    const allowed = planBoardChunkEdits(makeManifest(nearLimit), [], [newObject], { allowNew: true });
    expect(allowed.changed).toHaveLength(1);

    const atLimit = Array.from({ length: 8 }, (_, index) => chunkRef(
      `byte-over-${index}`,
      { objects: 1, samples: 0 },
      INK_BOARD_LIMITS.chunk_max_bytes,
    ));
    expect(() => planBoardChunkEdits(makeManifest(atLimit), [], [newObject], { allowNew: true }))
      .toThrow(/byte|content/i);
  });
});
