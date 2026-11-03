# Task 5 — defensive file dispatch exclusion

Status: **Extractor, full indexing factory, and shared content resolver exclude managed Ink; updated gate tests await main verification**

## Extractor

- `ref_handlers::extract_file_text_with_strategy` now checks the case-insensitive `.dsink` extension and the exact managed Ink MIME (`application/vnd.deepstudent.ink+json`, looked up by file/resource ID) before OCR, extracted-text, or base64 parsing.
- It returns an explicit unsupported notice directing the model to `ink_get` or `ink_render`. The focused test also asserts raw manifest JSON is absent and ordinary `.json` / Markdown extraction still works.
- Main's existing RED evidence is `verification/task-5-exclusion-red.log`; this owner did not rerun it or any tests.

Selector: `cargo test -p dstu-vfs --lib vfs::ref_handlers::tests::dsink_manifest_is_not_file_text_or_ocr`

## Managed indexing boundary

- Added `vfs::indexing::tests::sync_resource_to_units_excludes_managed_ink_but_keeps_ordinary_json` at the actual `VfsFullIndexingService::sync_resource_to_units` DB boundary. It creates Ink via `VfsInkRepo::create_blank_with_conn`, checks canonical `.dsink` file name, MIME and `preview_json.ink`, injects hostile manifest/resource/OCR/extracted fields, expects zero units, and verifies an ordinary JSON file still creates an index unit.
- `VfsFullIndexingService::sync_resource_to_units` now excludes file resources identified by managed Ink MIME, `.dsink` file extension (case-insensitive), or the canonical `preview_json.ink` marker before forming `UnitBuildInput`. It does not pass source/drawing JSON, extracted text, or OCR into the builder.
- Shared `resolve_indexable_content` now uses the same DB metadata predicate before reading `resources.ocr_text`, `resources.data`, or extracted/OCR fields, preventing a direct caller such as deprecated `VfsIndexingService::index_resource` from indexing a managed drawing manifest. Metadata lookup failure fails closed for file/image resources.
- Added `vfs::indexing::tests::resolve_indexable_content_excludes_managed_ink_and_keeps_ordinary_json`, authored before this shared guard. It independently checks exact managed MIME and canonical `preview_json.ink` detection against poisoned `resources.data`; ordinary JSON extraction remains indexable. No RED was captured by this owner because execution was prohibited; this selector is awaiting main's verification and is not reported as a verified RED.

Selector: `cargo test -p dstu-vfs --lib vfs::indexing::tests::resolve_indexable_content_excludes_managed_ink_and_keeps_ordinary_json`
- On this path, `index_unit_repo::sync_units` is given an empty input list to delete stale Units and enqueue their indexed segments for cleanup, then the resource is marked disabled. The full indexing entry also routes managed Ink through this factory cleanup before the valid-unit reuse shortcut, preventing old manifest Units from being retained on later index attempts.
- The gate test now seeds an old manifest-text Unit before invoking the factory, asserts zero units remain, and verifies ordinary JSON still creates an index unit. The removed title-only `FileBuilder` test remains removed.

Selector: `cargo test -p dstu-vfs --lib vfs::indexing::tests::sync_resource_to_units_excludes_managed_ink_but_keeps_ordinary_json`

## PDF/OCR command preflight

- Existing `PdfProcessingService::detect_media_type` rejects canonical managed Ink metadata: `MediaType::from_mime` supports only PDF/image MIME, and its extension fallback does not recognize `.dsink`. `start_pipeline` calls this private classifier before task insertion/spawning, so no extra production guard was added.
- Added a migrated-VFS fixture test invoking the private actual `detect_media_type` classifier on a canonical managed Ink row, asserting unsupported-media refusal and that no task exists. This directly tests the preflight classifier without risking any OCR/model call in test execution.

Selector: `cargo test -p dstu-vfs --lib vfs::pdf_processing_service::tests::detect_media_type_refuses_managed_ink_before_ocr`

Main's `task-2-vfs-ink-gates-r7.log` reports the extractor and PDF refusal tests passing and the indexing gate failing because the manifest text was indexed. The factory guard and stale-unit cleanup were then implemented in response. This owner did not run tests, builds, installs, commits, pushes, or agents; main owns the rerun/verification of the updated guard. The PDF refusal behavior was also confirmed by main's reported test result.
