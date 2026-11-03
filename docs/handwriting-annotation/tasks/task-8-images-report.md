# Task 8 image compiler — implementation handoff

Status: `GREEN` for the local compiler and shared total-image budget gates. Main reports `task-8-images-green-r1.log` passed the 7 compiler tests, and `task-8-total-budget-green.log` passed all 8 shared-budget tests (including the total-four-images cap) with exit code 0. This agent did not run tests.

## Implemented API

`compile_ink_visual_message(vfs_db, session_id, tool_name, tool_call_id, round_last_tool_call_id, refs, budget, is_multimodal) -> Result<Option<LegacyChatMessage>, InkImageError>` is `pub(crate)` and re-exported from `context_compiler`. It accepts only `builtin-ink_render` or its bare internal alias `ink_render`, checks each ref's parent session/call/round anchor, loads bytes via `VfsInkArtifactRepo::load_with_conn`, and matches stored artifact ID/render/document/page/revision/blob/resource/content hash/MIME/dimensions against each typed ref. It rejects non-PNG, over-2048-edge, or over-4-MiB images; no URL/network lookup is used. It returns a user multimodal message with document/page/revision labels and actual `ImageUrl` base64 parts. Errors are `VISION_MODEL_REQUIRED` for non-multimodal routes and `IMAGE_DELIVERY_FAILED: ...` for invalid/unavailable delivery.

All refs are loaded and validated before budget mutation. Previously delivered identical blob hashes are skipped only after current ref provenance has been validated. Fresh batches that exceed count or byte budget fail without committing any hashes or bytes. The budget's `commit_batch_with_bytes` also validates the entire batch before mutating it.

## Shared image budget

`RetrievalPageImageBudget` remains the single shared count/hash budget and derives `Clone`. `new_with_bytes(image_budget, images_in_request, image_bytes_in_request, already_referenced_blobs)` seeds the shared 16 MiB byte limit and now sets count remaining to `min(image_budget, 4).saturating_sub(images_in_request)`, so existing request images count against the total four-image cap. Existing `new(...)` remains for count-only compatibility/tests. `remaining()`, `remaining_bytes()`, `contains_blob()`, `commit_with_bytes(hash, byte_len)`, and atomic `commit_batch_with_bytes(&[(&str, usize)])` support the compiler and retrieval injector. Each committed image is capped at 4 MiB. Retrieval now commits the decoded image byte length. `count_request_image_bytes(messages)` is available to let the separate integration worker seed the budget from existing multimodal/legacy image parts; live/multi-variant constructors remain integration work.

## Gate test selectors (not run in this handoff)

- Positive real-blob message: `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::ink_images::tests::migrated_ink_artifact_compiles_to_labeled_user_image_with_original_png_bytes -- --exact`
- Forged session/call/round and MCP namespace: `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::ink_images::tests::rejects_untrusted_parent_and_tool_names_without_budget_use -- --exact`
- Artifact-ref field mismatches: `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::ink_images::tests::rejects_each_mismatched_artifact_reference_field_without_budget_use -- --exact`
- Missing published artifact/blob: `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::ink_images::tests::rejects_missing_artifact_and_missing_published_blob_bytes -- --exact`
- Nonvision on empty refs (current API contract): `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::ink_images::tests::nonvision_gate_precedes_empty_reference_noop -- --exact`
- Duplicate refs and atomic compiler rollback: `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::ink_images::tests::duplicate_blob_refs_deliver_once_and_charge_shared_budget_once -- --exact` and `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::ink_images::tests::invalid_member_and_budget_exhaustion_leave_batch_budget_unchanged -- --exact`
- Existing images count toward max four; mixed shared ink/retrieval count+byte limits: `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::retrieval_images::tests::budget_respects_total_image_budget_turn_cap_and_dedupe -- --exact` and `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::retrieval_images::tests::shared_budget_caps_four_images_and_sixteen_mebibytes_for_all_injectors -- --exact`
- Atomic byte-budget batch failure: `cargo test -p dstu-agent --lib chat_v2::pipeline::context_compiler::retrieval_images::tests::failed_batch_budget_commit_is_atomic -- --exact`.

The compiler API is available for the live/replay tool-round integrator; it does not yet place messages after the complete tool round or alter persisted chat/history. HTTP-captured provider request coverage and cumulative-history accounting remain later integration requirements.