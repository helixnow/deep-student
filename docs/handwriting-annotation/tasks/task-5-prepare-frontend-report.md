# Task 5 Prepare — frontend implementation

## Implemented

- `src/features/ink/prepare/source.ts` exports `prepareSourcePages(bytes, format, options)` for PDF, image, DOCX, and PPTX sources.
- PDF conversion uses the installed `react-pdf`/PDF.js worker URL and existing `PDF_OPTIONS` from `src/utils/pdfConfig.ts`. It validates page count, renders pages serially using each page's rotated viewport (including its CropBox), emits full-page PNGs, observes abort signals, and releases render/document/canvas resources.
- Image conversion decodes local bytes with `createImageBitmap` using `imageOrientation: 'from-image'`, returns one fixed PNG page, and closes its bitmap and canvas resources.
- Both paths cap output long edge at 2048px and pixels per page at 16 million by default; caller limits are bounded by those maxima. DOCX/PPTX are delegated to `convertOfficePages`.
- The CT fixtures and assertions are in `tests/ct/ink-prepare/fixtures.ts`, `SourcePrepareHarness.tsx`, and `sourcePrepare.spec.tsx`. They cover real generated PDF/PNG pixels, PDF page ordering, CropBox/rotation, output dimensions, and limits encoded in the API.

## Verification

The main run reported that both scoped CT tests compiled and reached the original `CONVERSION_FAILED` stub, with the expected success assertions failing (log: `task-5-source-frontend-red.log`). The implementation was not verified with a GREEN run: per instruction, no tests, build, install, or other execution commands were run here. Main should run `tests/ct/ink-prepare/sourcePrepare.spec.tsx` to validate the output assertions.