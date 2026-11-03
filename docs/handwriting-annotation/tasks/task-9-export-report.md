# Task 9 export test slice report

## Scope completed

Implemented the pure export functions against the shared ink renderer and the installed `pdfmake`; updated the CT helper to stop immediately on a visible export error before asserting success.

- `src/features/ink/export.ts`: exports PNG with optional crop, and flattened-raster PDF. PDF pages are rendered sequentially and wrapped in `pdfmake` sections using per-page dimensions, preserving page aspect ratios and the selected ID order. Both the document and each section use `[0, 0, 0, 0]` margins because pdfmake's section layout falls back with `sectionNode.pageMargins || this.pageMargins`, which incorrectly treats numeric `0` as unset and otherwise applies 40pt margins.
- `tests/ct/ink-export/InkExportHarness.tsx`: supplies in-memory canvas backgrounds, exercises the export API, and decodes/renders resulting PDF bytes with installed `pdfjs-dist` using the bundled worker URL and `PDF_OPTIONS`. The PDF run also renders page B as a standalone PNG and exposes blue-pixel counts for that PNG and each PDF page, isolating whether the arrow is lost before or during PDF composition.
- `tests/ct/ink-export/export.spec.tsx`: retains the three real PNG/crop/PDF byte and pixel cases; locator evaluation ignores its element argument and fetches the supplied Blob URL, serializes bytes as a plain number array, then reconstructs a Node `Buffer` so PDF signature checks use valid ASCII decoding. Export errors fail fast rather than waiting for the full test timeout. Asserts source pages/references remain unchanged after successful PDF export and adds a mid-PDF-raster-encoding cancellation case that verifies no artifact is published and input pages/references remain unchanged.
- `src/features/ink/__tests__/export.test.ts`: adds rejection gates for pre-cancelled PNG/PDF, invalid crop/long-edge options, empty/unknown/duplicate page selections, invalid page dimensions, aggregate estimated-byte budget, and more than 500 pages. Each invalid-input group verifies rejection occurs before canvas allocation.

Export checks cancellation before rendering, per PDF page, and before publishing bytes; enforces positive finite `long_edge` up to 4096, the renderer's 16M pixel cap, 500-page cap, unique page IDs, valid selected IDs/order, an estimated 200 MiB raster byte cap, and a final 200 MiB PDF byte cap. No font tables are required for image-only PDF output.

## Verification status

The main reported `task-9-export-margin-green.log` exited 0 with all three PNG/crop/PDF CT cases passing, including both PDF ink colors; `task-9-export-negative.log` exited 0 with 5 tests passing; and `task-9-export-cancel.log` exited 0 with 4 CT cases passing, including PDF pixels, cancellation, and source immutability. No additional verification was run for this report update.

## Intentionally not included

Integration with the app bridge, Office, editor, or source preparation is left for later work and remains owned by the other workstreams. No renderer or unrelated ink files were changed; full-branch main review is still pending.
