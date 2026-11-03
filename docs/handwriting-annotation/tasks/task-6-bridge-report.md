# Task 6 Bridge Report

Status: `NEEDS_GREEN_VERIFICATION`

## Implemented render flow

- `/home/xutao/deepstudent/deep-student/src-tauri/src/ink_bridge.rs` contains the Tauri app bridge and pure pending bus. `InkRenderSpec` accepts `document_id`, `expected_revision`, `page_id`, logical `crop`, and `long_edge` (1–2048). `build_render_request(manifest, page_ref, page, render_id)` freezes page/ref/revision/background identity. Render IDs hash the spec, manifest revision, source hash, conversion revision, source-annotation snapshot hash, and renderer profile.
- `vfs_ink_render`/`render_ink_snapshot` flush the main webview's editor (`EDITOR_BUSY` blocks publication), read the VFS manifest/page/background refs and source annotations in one read transaction, emit `ink:render-request`, then await the identity-bound response. `session_id` and `tool_call_id` must be supplied together and are checked on response.
- `vfs_ink_render_result` only accepts the actual configured `main` `WebviewWindow`, routes structured success/failure to the pending request, and failure is no longer a timeout-only path. On success Rust consumes the staged upload once, bounds bytes/dimensions, rechecks manifest revision/source/conversion/annotations immediately before publication, then calls `VfsInkArtifactRepo::store_png_with_conn`. `vfs_ink_render` returns the immutable `InkArtifact` metadata.
- `vfs_ink_flush_result` acknowledges main-webview flush with request/document binding. `App.tsx` lazy-imports and mounts the global listener at root, independent of editor presence.
- `/home/xutao/deepstudent/deep-student/src/features/ink/renderBridge.ts` uses the shared canvas renderer, fetches only VFS-owned frozen background blob hashes, decodes images/PDF pages, includes source highlights, stages a PNG (4 MiB cap), invokes the result command, and reports structured failure including stack diagnostics.
- Added `renderInkSnapshot` API metadata/spec types in `/home/xutao/deepstudent/deep-student/src/features/ink/api.ts`. Registered app state and commands in `src-tauri/src/lib.rs`; added command permissions. The CT harness now captures request/result/failure and raw staged PNG bytes without mounting an editor.

Main reported earlier red evidence: initial bus selector had five expected failures in `task-6-bus-red.log`; frozen-builder test failed on `NotImplemented`; the CT selector failed with missing result. Main is rerunning integration after these changes. This worker did not run any tests or builds, so no green claim is made. Exact selectors from the main report:

```bash
# from /home/xutao/deepstudent/deep-student/src-tauri
cargo test --lib ink_bridge::tests

# from /home/xutao/deepstudent/deep-student
npx playwright test -c playwright-ct.config.ts tests/ct/ink/renderBridge.spec.tsx
```

## Remaining app jobs

The next required shared app-job API is not implemented in this slice; do not treat these as optional or infer there is no renderer dependency:

```text
prepare_source_ink(app, db, source_resource_id, operation_id, session_id, tool_call_id, cancellation) -> InkManifest
export_ink_document(app, db, document_id, expected_revision, page_ids, format, operation_id, session_id, tool_call_id, cancellation) -> VFS file
```

Both should use the trusted app job bus and frozen source/page inputs: frontend source preparation renders frozen local bytes to staged PNG pages then backend calls the existing `VfsInkPrepareRepo`; export renders frozen Ink pages via shared `exportInkPng`/`exportInkPdf` frontend helpers then stages the real file bytes for backend VFS storage. Keep these on the same app bridge/job boundary rather than creating per-feature frameworks. No Chat/core persistence types or artifact repository files were edited here.
