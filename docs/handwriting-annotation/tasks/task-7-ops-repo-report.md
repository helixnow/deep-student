# Task 7 operation repository — implementation handoff

## Implemented before this review gate

- `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-vfs/src/vfs/repos/ink_operation_repo.rs` implements `VfsInkOperationRepo::apply_with_conn`: it hashes operation input, loads canonical manifest/pages, applies the bounded batch, records the receipt/revision, and commits only affected pages through `VfsInkRepo::commit_document_with_conn`.
- Frozen mappings are checked against the immutable artifact repository for document, revision, page, and crop. Exact retries are resolved before rechecking mappings against the advanced revision; reused IDs with changed input and stale document revisions are rejected.
- Existing DB coverage includes text+arrow commit/reopen, exact retry with no duplicate storage, and invalid second-operation rollback.
- The repo module/export is registered in `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-vfs/src/vfs/repos/mod.rs`. `commit_document_with_conn` was already `pub(crate)`, so `ink_repo.rs` was not changed.

## Provenance regression tests

- `full_page_render_without_artifact_crop_accepts_full_page_mapping` covers the normal frozen-render representation `crop: None` with a logical full-page mapping; validation normalizes that artifact to the page's canonical full-page rectangle.
- `forged_missing_cross_document_and_stale_render_mappings_are_rejected_without_mutation` exercises forged crop, missing render, cross-document ownership, and prior-revision render cases.
- `reused_operation_id_with_different_input_is_rejected_without_mutation` checks changed input under an already committed apply operation ID.

## Idempotency and undo payload contract

The manifest receipt is the persistence-layer idempotency anchor: operation ID, input hash, previous revision, and result revision. The existing caller/toolblock must durably store the undo payload with that identity: document ID, operation ID, previous/result revisions, `object_changes` (before/after objects), and `appended_page_ids`. An exact retry must reuse the original persisted toolblock result rather than overwrite it with the repo replay result, whose `object_changes` are empty. If the original toolblock record is unavailable, fail undo as unprovable rather than synthesizing incomplete data. The service boundary should accept a toolblock ID and load this trusted payload server-side; no new table/schema is proposed.

## Undo persistence implemented

- `VfsInkOperationRepo::undo_with_conn` accepts trusted internal `InkObjectChange` values and appended-page IDs, hashes them with document/expected revision, checks manifest receipt replay and operation-ID reuse, and generates a fresh revision/receipt.
- It loads canonical VFS manifest/pages, delegates object before/after validation and appended-page safety to pure `undo_operations`, then commits only affected surviving pages with `VfsInkRepo::commit_document_with_conn`.
- Later unrelated human objects are preserved; changed AI-touched objects and appended pages containing later drawings fail closed before persistence. The repo does not access Chat DB or add a table. The service/command boundary must accept a toolblock identifier and load the trusted payload server-side, never model-supplied change data.
- Real-DB tests cover successful undo while preserving a later human stroke; both changed-AI-object and drawn-appended-page rejections assert the structured `ink.revision_conflict` key and unchanged manifest/page/blob state.
- Added exact undo retry coverage asserting the same revision/receipt and no storage-reference changes; reusing the undo ID with changed payload must fail as `ink.operation_id_reused` without creating another revision.

## Verification and limits

The coordinator reported `task-2-vfs-ink-gates-r7.log` compiled 85 tests; apply/full-page/retry tests passed, and undo’s success test failed against the stub while the two negatives passed vacuously. No tests or builds were run after implementing undo or tightening these assertions; the main verification run remains pending. No install, agent, or commit was performed.
