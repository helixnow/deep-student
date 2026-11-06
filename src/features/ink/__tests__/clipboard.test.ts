import { describe, expect, it, vi } from 'vitest';
import type {
  InkObject,
  InkObjectContent,
  InkPage,
  InkPageRef,
  InkPoint,
  InkRect,
  InkSample,
} from '../types';
import { INK_LIMITS } from '../types';
import { parseInkClipboard, pasteInkClipboard, serializeInkClipboard } from '../clipboard';

/**
 * Stage C2 pure contract for `src/features/ink/clipboard.ts`.
 *
 * Surface:
 *   serializeInkClipboard(objects: InkObject[]): string
 *   parseInkClipboard(text: string): InkClipboardPayload
 *   pasteInkClipboard(payload, placement): InkPage
 *
 * Payload shape (exact keys):
 *   { format: 'deep-student.ink-clipboard', version: 1,
 *     origin: InkPoint, bounds: InkRect,
 *     objects: Array<{ index: number; content: InkObjectContent }> }
 *
 * The wire payload carries vector content and sequence indices only. Source
 * object ids, author, created_at, document paths, receipts, and any other
 * authority metadata are prohibited, even though each entry is object-shaped.
 * parse may rebuild temporary safe ids internally; callers must not expect
 * source metadata to survive.
 *
 * serialize computes origin = bounds top-left and bounds from control geometry
 * only (stroke sample points, text/rect/ellipse/region rects, arrow endpoints);
 * stroke width is NOT padded. It throws RangeError for an empty object list.
 * parse rejects JSON text larger than 8 MiB (UTF-8, matching the existing page
 * byte budget) before JSON.parse, duplicate keys, unknown keys at every level,
 * invalid format/version/colors, non-finite numbers, non-monotonic elapsed_ms,
 * and text/object/sample capacity overruns. Validation is all-or-none.
 *
 * Placement: { page, pageRef, center?, offset? }.
 * - offset defaults to { x: 16, y: 16 }; center and offset are mutually exclusive.
 * - center aligns the selection-bounds center to that page point.
 * - Fixed pages translate the whole selection to fit; never per-point clamp or
 *   scale. If the full visible footprint (including stroke width) exceeds
 *   pageRef width/height, throw RangeError before producing any object.
 * - Pasted copies always get fresh unique ids, author 'user', and a fresh
 *   caller-time timestamp; payload content never grants authority. Inputs are
 *   not mutated. One undo/journal operation is the caller's responsibility.
 */
interface InkClipboardObject {
  index: number;
  content: InkObjectContent;
}

interface InkClipboardPayload {
  format: 'deep-student.ink-clipboard';
  version: 1;
  origin: InkPoint;
  bounds: InkRect;
  objects: InkClipboardObject[];
}

interface InkPastePlacement {
  page: InkPage;
  pageRef: InkPageRef;
  center?: InkPoint;
  offset?: InkPoint;
}

const FORMAT = 'deep-student.ink-clipboard';

const strokeSource: InkObject = {
  id: 'source-stroke',
  author: 'ai',
  created_at: 1,
  content: {
    kind: 'stroke',
    samples: [
      { x: 0, y: 0, pressure: 0.5, elapsed_ms: 0 },
      { x: 10, y: 10, pressure: 0.5, elapsed_ms: 5 },
    ],
    style: { tool: 'pen', color: '#112233', width: 4, pressure_enabled: false },
  },
};

const textSource: InkObject = {
  id: 'source-text',
  author: 'user',
  created_at: 2,
  content: {
    kind: 'text',
    rect: { x: 0, y: 20, width: 30, height: 10 },
    text: 'hello',
    font_size: 12,
    color: '#445566',
  },
};

const sourceObjects = [strokeSource, textSource];

function pageRef(width: number, height: number): InkPageRef {
  return {
    page_id: 'page-1',
    width,
    height,
    background: { kind: 'blank', ruling: 'blank' },
    page_blob_hash: 'page-blob',
  };
}

function emptyPage(): InkPage {
  return { schema_version: 1, page_id: 'page-1', objects: [] };
}

function payloadJson(objects: unknown[], bounds: InkRect = { x: 0, y: 0, width: 1, height: 1 }): string {
  return JSON.stringify({
    format: FORMAT,
    version: 1,
    origin: { x: bounds.x, y: bounds.y },
    bounds,
    objects,
  });
}

function strokePayload(elapsed: number[]): string {
  return payloadJson([{
    index: 0,
    content: {
      kind: 'stroke',
      samples: elapsed.map((ms, index) => ({ x: index, y: 0, pressure: 0.5, elapsed_ms: ms })),
      style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: false },
    },
  }], { x: 0, y: 0, width: 2, height: 1 });
}

function strokeContent(object: InkObject) {
  return object.content as Extract<InkObject['content'], { kind: 'stroke' }>;
}

function textContent(object: InkObject) {
  return object.content as Extract<InkObject['content'], { kind: 'text' }>;
}

describe('ink clipboard (stage C pure contract)', () => {
  describe('vector payload', () => {
    it('round-trips vector content, order, origin, and bounds without source metadata', () => {
      const serialized = serializeInkClipboard(sourceObjects);
      const payload = parseInkClipboard(serialized);

      expect(payload).toEqual({
        format: FORMAT,
        version: 1,
        origin: { x: 0, y: 0 },
        bounds: { x: 0, y: 0, width: 30, height: 30 },
        objects: [
          { index: 0, content: strokeSource.content },
          { index: 1, content: textSource.content },
        ],
      });
      expect(payload.objects.map((object) => object.index)).toEqual([0, 1]);
      expect(payload.objects[0].content).toEqual(strokeSource.content);

      // No source id/author/timestamp/authority fields reach the system clipboard.
      for (const forbidden of ['source-stroke', 'source-text', '"author"', '"created_at"']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('rejects unknown fields, wrong versions, nested unknown fields, and duplicate JSON keys', () => {
      const payload = JSON.parse(serializeInkClipboard(sourceObjects));

      expect(() => parseInkClipboard(JSON.stringify({ ...payload, extra: true }))).toThrow();
      expect(() => parseInkClipboard(JSON.stringify({ ...payload, version: 2 }))).toThrow();
      expect(() => parseInkClipboard(JSON.stringify({
        ...payload,
        objects: [{ ...payload.objects[0], extra: 1 }, payload.objects[1]],
      }))).toThrow();

      // JSON.parse would silently keep the last value; the validator must reject duplicates
      // independently of serialize formatting.
      const duplicate =
        `{"format":"${FORMAT}","version":1,"version":1,`
        + `"origin":{"x":0,"y":0},"bounds":{"x":0,"y":0,"width":1,"height":1},"objects":[`
        + `{"index":0,"content":{"kind":"text","rect":{"x":0,"y":0,"width":1,"height":1},`
        + `"text":"a","font_size":1,"color":"#000000"}}]}`;
      expect(() => parseInkClipboard(duplicate)).toThrow();
    });

    it('rejects non-finite and raw NaN JSON number literals', () => {
      const rawStroke = (x: string) =>
        `{"format":"${FORMAT}","version":1,"origin":{"x":0,"y":0},`
        + `"bounds":{"x":0,"y":0,"width":10,"height":10},"objects":[`
        + `{"index":0,"content":{"kind":"stroke",`
        + `"samples":[{"x":${x},"y":0,"pressure":0.5}],`
        + `"style":{"tool":"pen","color":"#000000","width":2,"pressure_enabled":false}}}]}`;

      for (const literal of ['1e999', 'NaN', '-Infinity']) {
        expect(() => parseInkClipboard(rawStroke(literal))).toThrow();
      }
    });

    it('rejects non-monotonic stroke elapsed_ms', () => {
      expect(() => parseInkClipboard(strokePayload([0, 10, 9]))).toThrow();
      expect(() => parseInkClipboard(strokePayload([0, -1]))).toThrow();
    });

    it('rejects text and object-count budget overruns without returning a payload', () => {
      const oversizedText = {
        index: 0,
        content: {
          kind: 'text',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          text: 'a'.repeat(INK_LIMITS.text_max_chars + 1),
          font_size: 1,
          color: '#000000',
        },
      };
      expect(() => parseInkClipboard(payloadJson([oversizedText]))).toThrow();

      const tooManyObjects = Array.from({ length: INK_LIMITS.page_objects_max + 1 }, (_, index) => ({
        index,
        content: {
          kind: 'text',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          text: 'a',
          font_size: 1,
          color: '#000000',
        },
      }));
      expect(() => parseInkClipboard(payloadJson(tooManyObjects))).toThrow();
    });
  });

  describe('paste', () => {
    it('creates new ids, author, and timestamps while preserving vector style, order, and relative placement', () => {
      const payload = parseInkClipboard(serializeInkClipboard(sourceObjects));
      const payloadSnapshot = JSON.parse(JSON.stringify(payload));
      const page = emptyPage();
      const before = Date.now();

      const pasted = pasteInkClipboard(payload, { page, pageRef: pageRef(500, 500) });
      const ids = pasted.objects.map((object) => object.id);

      expect(pasted).not.toBe(page);
      expect(pasted.page_id).toBe('page-1');
      expect(pasted.objects).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      expect(ids).not.toContain('source-stroke');
      expect(ids).not.toContain('source-text');
      expect(pasted.objects.map((object) => object.author)).toEqual(['user', 'user']);
      for (const object of pasted.objects) {
        expect(object.created_at).toBeGreaterThanOrEqual(before);
      }

      expect(strokeContent(pasted.objects[0]).style).toEqual(strokeSource.content.kind === 'stroke'
        ? strokeSource.content.style
        : undefined);
      expect(strokeContent(pasted.objects[0]).samples).toEqual([
        { x: 16, y: 16, pressure: 0.5, elapsed_ms: 0 },
        { x: 26, y: 26, pressure: 0.5, elapsed_ms: 5 },
      ]);
      expect(textContent(pasted.objects[1]).rect).toEqual({ x: 16, y: 36, width: 30, height: 10 });
      expect(textContent(pasted.objects[1]).text).toBe('hello');

      // Inputs are untouched.
      expect(page).toEqual(emptyPage());
      expect(payload).toEqual(payloadSnapshot);
    });

    it('places the selection-bounds center at the requested center point', () => {
      const payload = parseInkClipboard(serializeInkClipboard(sourceObjects));
      const pasted = pasteInkClipboard(payload, {
        page: emptyPage(),
        pageRef: pageRef(500, 500),
        center: { x: 250, y: 250 },
      });

      expect(strokeContent(pasted.objects[0]).samples).toEqual([
        { x: 235, y: 235, pressure: 0.5, elapsed_ms: 0 },
        { x: 245, y: 245, pressure: 0.5, elapsed_ms: 5 },
      ]);
      expect(textContent(pasted.objects[1]).rect).toEqual({ x: 235, y: 255, width: 30, height: 10 });
    });

    it('translates the whole selection to fit, and rejects an oversize target all-or-none', () => {
      const payload = parseInkClipboard(serializeInkClipboard(sourceObjects));
      const payloadSnapshot = JSON.parse(JSON.stringify(payload));

      // 30x30 selection + default 16 offset would end at 46; shift the whole selection by -6.
      const translated = pasteInkClipboard(payload, {
        page: emptyPage(),
        pageRef: pageRef(40, 40),
      });
      expect(strokeContent(translated.objects[0]).samples).toEqual([
        { x: 10, y: 10, pressure: 0.5, elapsed_ms: 0 },
        { x: 20, y: 20, pressure: 0.5, elapsed_ms: 5 },
      ]);
      expect(textContent(translated.objects[1]).rect).toEqual({ x: 10, y: 30, width: 30, height: 10 });

      // Selection itself is larger than the target page: no partial write.
      const tooSmall = emptyPage();
      expect(() => pasteInkClipboard(payload, {
        page: tooSmall,
        pageRef: pageRef(20, 20),
      })).toThrow(RangeError);
      expect(tooSmall).toEqual(emptyPage());
      expect(payload).toEqual(payloadSnapshot);
    });

    it('rejects a paste that would exceed the target object budget, leaving the target untouched', () => {
      const payload = parseInkClipboard(serializeInkClipboard(sourceObjects));
      const filler = Array.from({ length: INK_LIMITS.page_objects_max - 1 }, (_, index): InkObject => ({
        id: `target-${index}`,
        author: 'user',
        created_at: 1,
        content: {
          kind: 'text',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          text: '',
          font_size: 1,
          color: '#000000',
        },
      }));
      const target: InkPage = { schema_version: 1, page_id: 'page-1', objects: filler };
      const originalObjects = target.objects;
      const originalFirst = target.objects[0];
      const originalLast = target.objects[target.objects.length - 1];

      // 9,999 existing + 2 pasted = 10,001 > page_objects_max.
      expect(() => pasteInkClipboard(payload, { page: target, pageRef: pageRef(500, 500) }))
        .toThrow(RangeError);

      expect(target.objects).toBe(originalObjects);
      expect(target.objects).toHaveLength(INK_LIMITS.page_objects_max - 1);
      expect(target.objects[0]).toBe(originalFirst);
      expect(target.objects[target.objects.length - 1]).toBe(originalLast);
    });

    it('rejects a paste that would exceed the target sample budget, leaving the target untouched', () => {
      // A valid two-sample payload against a target already holding 99,999 samples.
      const payload = parseInkClipboard(serializeInkClipboard([strokeSource]));
      const sample: InkSample = { x: 0, y: 0, pressure: 0.5 };
      const samples = new Array<InkSample>(INK_LIMITS.page_samples_max - 1).fill(sample);
      const existingStroke: InkObject = {
        id: 'target-stroke',
        author: 'user',
        created_at: 1,
        content: {
          kind: 'stroke',
          samples,
          style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: false },
        },
      };
      const target: InkPage = { schema_version: 1, page_id: 'page-1', objects: [existingStroke] };
      const originalObjects = target.objects;

      // 99,999 existing + 2 pasted = 100,001 > page_samples_max.
      expect(() => pasteInkClipboard(payload, { page: target, pageRef: pageRef(500, 500) }))
        .toThrow(RangeError);

      expect(target.objects).toBe(originalObjects);
      expect(target.objects).toHaveLength(1);
      expect(strokeContent(target.objects[0]).samples).toBe(samples);
    });

    it('rejects a paste whose combined target and pasted page exceeds the byte budget, leaving the target untouched', () => {
      const payload = parseInkClipboard(serializeInkClipboard([textSource]));
      // 900 objects x 10,000 ASCII chars serialize well past 8 MiB; sharing the
      // string keeps the fixture itself small. Objects/samples stay in budget.
      const longText = 'a'.repeat(INK_LIMITS.text_max_chars);
      const filler = Array.from({ length: 900 }, (_, index): InkObject => ({
        id: `target-${index}`,
        author: 'user',
        created_at: 1,
        content: {
          kind: 'text',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          text: longText,
          font_size: 1,
          color: '#000000',
        },
      }));
      const target: InkPage = { schema_version: 1, page_id: 'page-1', objects: filler };
      const originalObjects = target.objects;

      expect(() => pasteInkClipboard(payload, { page: target, pageRef: pageRef(500, 500) }))
        .toThrow(RangeError);

      expect(target.objects).toBe(originalObjects);
      expect(target.objects).toHaveLength(900);
    });

    it('keeps generated ids unique across module instances under a fixed clock and a populated target', async () => {
      // Two windows import the module independently but see the same clock; the
      // second one pastes onto the page the first one already mutated.
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        vi.resetModules();
        const firstWindow = await import('../clipboard');
        vi.resetModules();
        const secondWindow = await import('../clipboard');

        const serialized = firstWindow.serializeInkClipboard(sourceObjects);
        const firstPaste = firstWindow.pasteInkClipboard(
          firstWindow.parseInkClipboard(serialized),
          { page: emptyPage(), pageRef: pageRef(500, 500) },
        );
        const secondPaste = secondWindow.pasteInkClipboard(
          secondWindow.parseInkClipboard(serialized),
          { page: firstPaste, pageRef: pageRef(500, 500) },
        );

        const ids = secondPaste.objects.map((object) => object.id);
        expect(secondPaste.objects).toHaveLength(firstPaste.objects.length + 2);
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        now.mockRestore();
        vi.resetModules();
      }
    });
  });
});
