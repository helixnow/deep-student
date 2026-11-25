// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createAnnotatedPdf } from '../pdfAnnotatedExport';
import type { Highlight } from '../components/EnhancedPdfViewer';

async function loadPdfJs(bytes: Uint8Array) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  });
  return task.promise;
}

function makeHighlight(
  overrides: Partial<Highlight> & Pick<Highlight, 'pageIndex' | 'rects'>,
): Highlight {
  return {
    id: overrides.id ?? 'hl-test',
    pageIndex: overrides.pageIndex,
    rects: overrides.rects,
    coordVersion: overrides.coordVersion ?? 2,
    color: overrides.color ?? '#fde047',
    text: overrides.text ?? 'Selected passage',
    comment: overrides.comment,
    createdAt: overrides.createdAt ?? '2026-11-25T00:00:00.000Z',
  };
}

function extractHighlightAnnots(pdf: PDFDocument, pageIndexZeroBased: number) {
  const page = pdf.getPage(pageIndexZeroBased);
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return [];
  const results: Array<{ rect: number[]; quadPoints: number[]; contents?: string }> = [];
  for (let i = 0; i < annots.size(); i += 1) {
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
    if (subtype?.asString() !== '/Highlight') continue;
    const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    const quadArr = dict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray);
    const contentsObj = dict.get(PDFName.of('Contents'));
    const rect = rectArr
      ? Array.from({ length: rectArr.size() }, (_, idx) => {
          const num = rectArr.lookupMaybe(idx, PDFNumber);
          return num ? num.asNumber() : NaN;
        })
      : [];
    const quadPoints = quadArr
      ? Array.from({ length: quadArr.size() }, (_, idx) => {
          const num = quadArr.lookupMaybe(idx, PDFNumber);
          return num ? num.asNumber() : NaN;
        })
      : [];
    const contents =
      contentsObj instanceof PDFHexString || contentsObj instanceof PDFString
        ? contentsObj.decodeText()
        : undefined;
    results.push({ rect, quadPoints, contents });
  }
  return results;
}

describe('createAnnotatedPdf', () => {
  it.each([0, 90, 180, 270] as const)(
    'exports v2 normalized highlights with 0%% drift on %i° rotated pages',
    async (rotation) => {
      const src = await PDFDocument.create();
      const page = src.addPage([600, 800]);
      page.setRotation(degrees(rotation));
      const srcBytes = await src.save();

      const doc = await loadPdfJs(srcBytes);
      try {
        // Asymmetric rect so any 90°/180°/270° rotation or axis swap immediately drifts
        const normRect = { x: 0.15, y: 0.22, width: 0.35, height: 0.08 };
        const exported = await createAnnotatedPdf(doc, [
          makeHighlight({
            id: `hl-rot-${rotation}`,
            pageIndex: 1,
            rects: [normRect],
            comment: `Note at ${rotation}deg`,
          }),
        ]);

        const outPdf = await PDFDocument.load(exported);
        const annots = extractHighlightAnnots(outPdf, 0);
        expect(annots).toHaveLength(1);
        const { rect, quadPoints, contents } = annots[0]!;
        expect(contents).toBe(`Note at ${rotation}deg`);

        // Rect must always be normalized [llx, lly, urx, ury] with positive area
        expect(rect).toHaveLength(4);
        expect(rect[0]).toBeLessThan(rect[2]!);
        expect(rect[1]).toBeLessThan(rect[3]!);

        // Round-trip every QuadPoint back through the rendered viewport (intrinsic rotation)
        expect(quadPoints).toHaveLength(8);
        const pdfJsPage = await doc.getPage(1);
        const viewport = pdfJsPage.getViewport({ scale: 1 });
        expect(viewport.rotation).toBe(rotation);

        const expectedViewportCorners: Array<[number, number]> = [
          [normRect.x * viewport.width, normRect.y * viewport.height],
          [(normRect.x + normRect.width) * viewport.width, normRect.y * viewport.height],
          [normRect.x * viewport.width, (normRect.y + normRect.height) * viewport.height],
          [(normRect.x + normRect.width) * viewport.width, (normRect.y + normRect.height) * viewport.height],
        ];

        for (let i = 0; i < 4; i += 1) {
          const [vx, vy] = viewport.convertToViewportPoint(
            quadPoints[i * 2]!,
            quadPoints[i * 2 + 1]!,
          );
          expect(vx).toBeCloseTo(expectedViewportCorners[i]![0], 3);
          expect(vy).toBeCloseTo(expectedViewportCorners[i]![1], 3);
        }

        // Verify exported PDF also loads back cleanly in PDF.js with matching annotation rect
        const reloadedDoc = await loadPdfJs(exported);
        try {
          const reloadedPage = await reloadedDoc.getPage(1);
          const reloadedAnnots = await reloadedPage.getAnnotations();
          expect(reloadedAnnots).toHaveLength(1);
          const reloadedRect = reloadedAnnots[0]!.rect as number[];
          for (let i = 0; i < 4; i += 1) {
            expect(reloadedRect[i]).toBeCloseTo(rect[i]!, 3);
          }
        } finally {
          await reloadedDoc.destroy();
        }
      } finally {
        await doc.destroy();
      }
    },
  );

  it.each([0, 90, 180, 270] as const)(
    'exports accurately with shifted CropBox on %i° rotated pages',
    async (rotation) => {
      const src = await PDFDocument.create();
      const page = src.addPage([700, 900]);
      page.setCropBox(60, 80, 500, 700);
      page.setRotation(degrees(rotation));
      const srcBytes = await src.save();

      const doc = await loadPdfJs(srcBytes);
      try {
        const normRect = { x: 0.2, y: 0.3, width: 0.4, height: 0.1 };
        const exported = await createAnnotatedPdf(doc, [
          makeHighlight({
            id: `hl-crop-${rotation}`,
            pageIndex: 1,
            rects: [normRect],
          }),
        ]);

        const outPdf = await PDFDocument.load(exported);
        const [annot] = extractHighlightAnnots(outPdf, 0);
        expect(annot).toBeDefined();

        const pdfJsPage = await doc.getPage(1);
        const viewport = pdfJsPage.getViewport({ scale: 1 });
        expect(viewport.rotation).toBe(rotation);

        // Rect stays strictly inside the shifted CropBox [60, 80, 560, 780]
        expect(annot!.rect[0]).toBeGreaterThanOrEqual(60 - 1e-3);
        expect(annot!.rect[1]).toBeGreaterThanOrEqual(80 - 1e-3);
        expect(annot!.rect[2]).toBeLessThanOrEqual(560 + 1e-3);
        expect(annot!.rect[3]).toBeLessThanOrEqual(780 + 1e-3);

        // QuadPoints round-trip to exact visual viewport corners
        const expectedCorners: Array<[number, number]> = [
          [normRect.x * viewport.width, normRect.y * viewport.height],
          [(normRect.x + normRect.width) * viewport.width, normRect.y * viewport.height],
          [normRect.x * viewport.width, (normRect.y + normRect.height) * viewport.height],
          [(normRect.x + normRect.width) * viewport.width, (normRect.y + normRect.height) * viewport.height],
        ];
        for (let i = 0; i < 4; i += 1) {
          const [vx, vy] = viewport.convertToViewportPoint(
            annot!.quadPoints[i * 2]!,
            annot!.quadPoints[i * 2 + 1]!,
          );
          expect(vx).toBeCloseTo(expectedCorners[i]![0], 3);
          expect(vy).toBeCloseTo(expectedCorners[i]![1], 3);
        }
      } finally {
        await doc.destroy();
      }
    },
  );

  it('loads and exports owner-password-restricted (encrypted) PDFs without crashing', async () => {
    // Build a valid PDF with an /Encrypt dictionary in its trailer (simulating an
    // owner-password-restricted PDF where pdf-lib rejects load() unless ignoreEncryption: true)
    const src = await PDFDocument.create();
    const page = src.addPage([612, 792]);
    page.setRotation(degrees(90));
    const encryptDict = src.context.obj({
      Filter: PDFName.of('Standard'),
      V: 1,
      R: 2,
      O: PDFHexString.of('00'.repeat(32)),
      U: PDFHexString.of('00'.repeat(32)),
      P: -4,
    });
    src.context.trailerInfo.Encrypt = src.context.register(encryptDict);
    const encryptedBytes = await src.save({ useObjectStreams: false });

    // Confirm pdf-lib rejects this document without ignoreEncryption
    await expect(
      PDFDocument.load(encryptedBytes, { updateMetadata: false }),
    ).rejects.toThrow(/encrypted/i);

    // Provide a mock PDFDocumentProxy whose getData returns the owner-restricted bytes
    // and whose getPage returns a real PDF.js viewport for the 90°-rotated 612x792 page
    const plain = await PDFDocument.create();
    plain.addPage([612, 792]).setRotation(degrees(90));
    const plainDoc = await loadPdfJs(await plain.save());
    try {
      const realPage = await plainDoc.getPage(1);
      const fakeProxy = {
        getData: async () => encryptedBytes,
        getPage: async () => realPage,
      };

      const exported = await createAnnotatedPdf(fakeProxy, [
        makeHighlight({
          id: 'hl-encrypted',
          pageIndex: 1,
          rects: [{ x: 0.1, y: 0.25, width: 0.5, height: 0.05 }],
          comment: 'Encrypted highlight',
        }),
      ]);

      expect(exported.byteLength).toBeGreaterThan(0);
      const loaded = await PDFDocument.load(exported, { ignoreEncryption: true });
      const annots = extractHighlightAnnots(loaded, 0);
      expect(annots).toHaveLength(1);
      expect(annots[0]!.contents).toBe('Encrypted highlight');

      const viewport = realPage.getViewport({ scale: 1 });
      const [vx, vy] = viewport.convertToViewportPoint(
        annots[0]!.quadPoints[0]!,
        annots[0]!.quadPoints[1]!,
      );
      expect(vx).toBeCloseTo(0.1 * viewport.width, 3);
      expect(vy).toBeCloseTo(0.25 * viewport.height, 3);
    } finally {
      await plainDoc.destroy();
    }
  });
});
