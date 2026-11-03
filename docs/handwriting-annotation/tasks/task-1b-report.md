# Task 1b operations and undo handoff — NEEDS_RED_VERIFICATION

## Scope

Implemented the pure operation batch transformer after the main agent confirmed the two initial positive tests compiled and failed at the `NOT_IMPLEMENTED` scaffold. The operation transform is in-memory only and returns new state only after validating all operations; no storage, rendering, approval, or service-layer work was added.

Main reported operations-green-r3: all 9 focused operation/wire tests passed after replacing derived deserialization on normalized point/rect and the internally tagged operation/content enums with strict helper-struct deserializers using direct `f64` fields, following the existing `InkObjectContent` pattern. No `serde_json::Number` adapters were introduced. This task hand did not rerun that suite.

Changed paths:

- `src-tauri/crates/dstu-vfs/src/vfs/ink/operations.rs`
- `src-tauri/crates/dstu-vfs/src/vfs/ink/operations_tests.rs`
- `src-tauri/crates/dstu-vfs/src/vfs/ink/mod.rs` (module/test/export wiring)
- `src/features/ink/types.ts` (append-only normalized operation request types)
- `docs/handwriting-annotation/tasks/task-1b-report.md`

## API shape

Rust exports `InkOperation`, `InkOperationContent`, normalized point/rect and coordinate-space types, `InkRenderMapping`, `InkOperationError`/codes, `InkObjectChange`, `InkOperationsResult`, and:

`apply_operations(manifest, pages, operations, render_mappings) -> Result<InkOperationsResult, InkOperationError>`

Operations cover append blank page; add text/rect/ellipse/arrow/region highlight; update controlled non-stroke content; remove object. The function signature receives existing `InkManifest` and `InkPage` domain types and returns cloned next state plus affected-page IDs, object before/after changes, and appended-page IDs. Mapping fields document the service-loaded, frozen, ownership-checked input contract; render lookup and revision/source checks remain service responsibilities. The TypeScript request union keeps geometry normalized, requires `based_on_render_id` for add/update, and omits service-generated IDs/timestamps (including append-page ID).

## Initial positive tests

Selectors under `vfs::ink::operations_tests`:

- `ink_operations_add_normalized_text_and_crop_mapped_arrow` — checks literal page-coordinate conversion (`800x1000` page text) and literal crop mapping (`x=100,y=200,width=400,height=500`), including AI author and object-change metadata.
- `ink_operations_append_blank_page_with_requested_geometry_and_ruling` — checks new page/ref geometry, ruling, empty logical `InkPage`, and appended ID.
- `ink_operation_wire_round_trip_preserves_literal_decimal_floats` — serializes an `AddText` plus an `UpdateObject(Arrow)` containing literal decimal f64 values, then deserializes with `serde_json::from_slice` and compares the exact values. Main reported the initial `invalid type: map, expected f64`; operations-green-r3 subsequently passed this test after the strict direct-f64 helper deserializers were added.
- `ink_operations_reject_empty_and_oversized_batches`
- `ink_operations_reject_mapping_geometry_and_missing_object_errors`
- `ink_operations_reject_duplicate_ids_invalid_content_and_stroke_updates`
- `ink_operations_late_failure_keeps_inputs_unchanged`
- `ink_operations_change_receipts_preserve_unrelated_objects` — checks update before/after metadata and an untouched neighboring object.
- Undo behavior selectors are listed in the dedicated red-gate section below.

Exact command for the main agent to run:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib vfs::ink::operations_tests
```

Main reported the initial operation red gate in `task-1b-operations-red.log` and operations-green-r3 with 9 passing focused behavior/wire tests. Undo tests and the `NOT_IMPLEMENTED` undo stub were added afterward; they remain unverified pending the red gate below. This hand did not run tests, builds, or installs.

## Wire diagnostic gate and implementation notes

Operations-green-r3 reports the operation behavior/wire tests green. The undo tests below remain unverified and are the current red-verification gate; main should run their selector shown there. No tests/builds/installs were run by this task hand.

The pure apply function validates the input manifest/pages, applies the full batch to cloned state, checks render ID/document/page/revision and crop bounds for add/update, maps normalized page/crop geometry, disallows stroke replacement, records object before/after and append-page identity, updates changed page hashes, then validates changed pages and the resulting manifest. Render lookup/ownership/source checks remain the document service's responsibility; mappings are trusted inputs once loaded and verified there. Storage, idempotency, and approval remain outside this module.

## Undo implementation handoff — NEEDS_MAIN_VERIFICATION

Implemented and exported `undo_operations(manifest, pages, changes, appended_page_ids)`. Main reported `task-1b-undo-red-r3` with all five real-state undo tests compiling and failing against the stub: three success-path failures and two expected conflict-code failures. The pure undo implementation now clones state, checks each target still equals the recorded `after`, restores/removes only touched objects, preserves unrelated objects, rejects appended pages with remaining contents, enforces at least one page, and validates final changed pages/manifest with refreshed page hashes. It preserves the input manifest revision unchanged and does not mutate caller-owned state; storage CAS remains the document service's responsibility.

Main should rerun the focused selector:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib vfs::ink::operations_tests::ink_undo_
```

Selectors:

- `vfs::ink::operations_tests::ink_undo_removes_ai_object_but_preserves_later_human_addition`
- `vfs::ink::operations_tests::ink_undo_restores_exact_before_object_including_author_and_timestamp`
- `vfs::ink::operations_tests::ink_undo_same_object_human_edit_conflicts_without_partial_changes`
- `vfs::ink::operations_tests::ink_undo_rejects_appended_page_with_later_human_content`
- `vfs::ink::operations_tests::ink_undo_removes_an_empty_appended_page`

The tests exercise real page/object state: remove an AI-added object while preserving an unrelated later human object; restore exact prior content, author, and timestamp; reject a later edit to the affected object with the entire batch unchanged; reject deleting an appended page containing later human content; and remove an empty appended page. Main must report the implementation result; this hand did not run tests/builds.
