# Task 6 app jobs — first gate

**Status: NEEDS_MAIN_REGRESSION_VERIFICATION**

The only reported passing verification is `/home/xutao/deepstudent/deep-student/docs/handwriting-annotation/verification/ink-jobs-r15.log`: two browser CT cases passed with staged PNG bytes and pixel assertions. Main reported app13 observed RED for three regressions: queued prepare cancellation, missing timeout notification, and PDF retry lookup after rerender. Those production paths are now connected to cancellation checks in the blocking precommit worker, timeout/cancel frontend abort notification, and durable receipt lookup before render, including concurrent exact retry reuse. Main also authorized the source-purged export regression and supplied `load_frozen_inputs_with_conn`; commit-time snapshot comparison now delegates to that shared validator. These changes have not been verified by this worker; main owns verification. Main has reported the current app-gate source snapshot is starting; no newer GREEN is recorded here.

## Changed files

- `/home/xutao/deepstudent/deep-student/src-tauri/src/ink_jobs.rs` — typed identity-scoped pending bus; trusted-main Tauri result command; prepare/export service entrypoints; bounded staged PNG/PDF validation; VFS manifest/background commit; stable export receipt ledger; queued prepare/export cancellation checks; timeout/cancel frontend abort notifications; pre-render PDF receipt reuse; transaction-time frozen input validation via shared `load_frozen_inputs_with_conn`; VFS errors mapped via existing `InkCommandError::from`.
- `/home/xutao/deepstudent/deep-student/src-tauri/src/ink_jobs_bus_tests.rs` — five registered bus contract tests cover response variants, main-webview trust, request/operation/kind/session/tool-call identity, timeout/cancel cleanup, and late-result rejection.
- `/home/xutao/deepstudent/deep-student/src-tauri/src/lib.rs` — job bus state and Tauri commands registered.
- `/home/xutao/deepstudent/deep-student/src-tauri/permissions/application-commands.toml` — prepare/export/result ACL entries.
- `/home/xutao/deepstudent/deep-student/src/features/ink/jobBridge.ts` — global listener, browser source preparation and frozen-page export, staged-byte result/error reporting.
- `/home/xutao/deepstudent/deep-student/src/features/ink/api.ts` and `/home/xutao/deepstudent/deep-student/src/features/ink/api.test.ts` — typed API entrypoints and transport test.
- `/home/xutao/deepstudent/deep-student/src/App.tsx` — app-level render/job bridge registration.
- `/home/xutao/deepstudent/deep-student/tests/ct/ink-jobs/InkJobsHarness.tsx` and `/home/xutao/deepstudent/deep-student/tests/ct/ink-jobs/jobs.spec.tsx` — real prepare/export browser helpers, staged-byte assertions, and pixel checks executed in the component page.

## DB test contracts

- `staged_png_page_is_committed_as_a_readable_owned_prepared_background` creates a migrated VFS image source and a real staged PNG, then expects a prepared manifest/page that reopens and owns readable PNG background bytes.
- `export_commits_independent_png_and_pdf_files_with_provenance_and_exact_retries` stages real PNG and PDF payloads, expects VFS output files with real content hashes and authoritative document-resource receipts, exact retries to return the same artifact, and the canonical manifest/source to remain unchanged.
- `malformed_second_prepared_page_releases_prior_temporary_blob_refs_and_stages` verifies later-page decode failure rolls back earlier temporary blob refs and consumes stage files.
- `cancelled_prepare_before_commit_consumes_stages_without_vfs_mutation` verifies pre-commit cancellation creates no extra file and consumes its stage.
- `export_operation_id_rejects_different_input_without_adding_receipt` verifies operation identity cannot be rebound to another format/payload.
- `identical_png_exported_by_two_documents_preserves_both_receipt_indexes` verifies content-addressed output metadata keeps both document artifact indexes while each document retains its own authoritative receipt.
- `cancellation_after_prepare_work_is_queued_prevents_manifest_commit_and_releases_stage` holds a real blocking-worker seam until cancellation, then expects no VFS mutation and released staged PNG.
- `pending_job_timeout_notifies_frontend_to_abort_staged_output` expects timeout to trigger the frontend staged-upload abort notifier.
- `cancellation_after_export_work_is_queued_prevents_vfs_commit_and_releases_stage` holds the export blocking worker until cancellation and expects no VFS file commit and stage cleanup.
- `pdf_export_retry_reuses_durable_receipt_before_rendering_new_pdf_bytes` expects a durable receipt lookup to reuse the first PDF artifact despite a regenerated PDF byte hash.
- `export_after_original_source_purge_uses_shared_frozen_source_guard` expects export to accept the same purged-source snapshot semantics as the shared render-input loader.

No DB migration is used. The authoritative export receipt ledger is append-only `metadata_json.ink_export_receipts` on the Ink document resource, keyed by operation ID and an input hash; repeated operation ID with different input or bytes conflicts. Export resource metadata carries an append-only `ink_exports` index only, not canonical provenance. The DB test now asserts the authoritative ledger.

## Exact selectors for main RED verification

Run from `/home/xutao/deepstudent/deep-student/src-tauri`:

```bash
cargo test --lib ink_jobs::tests::staged_png_page_is_committed_as_a_readable_owned_prepared_background
cargo test --lib ink_jobs::tests::export_commits_independent_png_and_pdf_files_with_provenance_and_exact_retries
```

Main should run from `/home/xutao/deepstudent/deep-student/src-tauri`:

```bash
cargo test --lib ink_jobs::tests
cargo test --lib ink_jobs::bus_tests
```

Frontend CT selectors from `/home/xutao/deepstudent/deep-student`:

```bash
npx playwright test -c playwright-ct.config.ts tests/ct/ink-jobs/jobs.spec.tsx
npx vitest run src/features/ink/api.test.ts
```

No tests/build/install/subagents/commit/push were run by this worker; main owns verification. Only the `/home/xutao/deepstudent/deep-student/docs/handwriting-annotation/verification/ink-jobs-r15.log` browser CT PASS is verified here. Native DB and bus gates remain compile-blocked/unverified. Main should run `cargo test --lib ink_jobs::tests` and `cargo test --lib ink_jobs::bus_tests`; UI selectors are listed above. Job responses carry only trusted staged metadata/bytes; JS-supplied manifest/artifact/file identities are never canonical.
