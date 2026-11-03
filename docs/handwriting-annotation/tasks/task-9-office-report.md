# Task 9 Office archive budget — OFFICE_COMPILE_READY

## Scope completed

- Added source, ZIP archive, per-entry, aggregate decoded-data, and total output PNG byte limits in `src/features/ink/prepare/office.ts`.
- ZIP entries are preflighted against directory metadata, then each entry is streamed through a bounded decoder to verify actual inflated byte counts before rendering. Package read/write transformations and PNG capture share the intended byte budgets.
- Corrected the `loadSafePackage` caller signature, stale ZIP budget references, and the duplicate image-extension local that prevented TypeScript compilation.

## Budget test cases

- No renderer DOM selectors are used by these ZIP preflight cases.
- `entry-count` creates a small compressed DOCX-shaped ZIP with 10,001 empty entries.
- `entry-size` patches one compressed entry's local and central uncompressed-size headers above 32 MiB; `total-size` patches five entries to 32 MiB each, exceeding 128 MiB aggregate. Compressed payloads are small, and the harness checks fixture byte length remains below the declared budget.
- Each case expects `LIMIT_EXCEEDED` and no attached `.ink-office-docx` or `.ink-office-pptx` staging host.

## Verification

- Main run `docs/handwriting-annotation/verification/ink-office-jobs-bridge-r12.log` reports all 10 Office CTs passing, including the budget case and the prior DOCX/PPTX conversion, cancellation, external-image, image-order, and chart cases.
- The full combined run reports 12/14 passing. The two failures are in the separate `ink-jobs` suite because its environment lacks `createImageBitmap`; they are outside this Office-only scope.
- No tests or builds were run in this slice. Typecheck result `typecheck-r12.log` is pending main-agent review.

## Concerns and limits

- The budget fixtures forge ZIP declared sizes while keeping compressed bytes and decoded fixture content small. A >128 MiB source fixture is omitted to avoid a huge allocation; the source-byte guard is implemented but not exercised by this fixture set.
