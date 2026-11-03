# Task 1 handoff

## Changed paths

- `src-tauri/crates/dstu-vfs/src/vfs/ink/mod.rs`
- `src-tauri/crates/dstu-vfs/src/vfs/ink/types.rs`
- `src-tauri/crates/dstu-vfs/src/vfs/ink/validate.rs`
- `src-tauri/crates/dstu-vfs/src/vfs/ink/tests.rs`
- `src-tauri/crates/dstu-vfs/src/vfs/mod.rs` (one `pub mod ink;` registration)
- `src/features/ink/types.ts`
- `tests/fixtures/ink/ink-manifest-v1.json`
- `tests/fixtures/ink/page-v1.json`
- `docs/handwriting-annotation/tasks/task-1-report.md`

## Initial red gate (verified by main)

Main reports that `cargo test -p dstu-vfs --lib ink_` compiled, with the four new positive tests failing on the structured `Unimplemented` stub and two unrelated tests passing. Log: `docs/handwriting-annotation/verification/task-1-positive-red.log`.

## Positive parse implementation handoff

Implemented both parse APIs as byte-limit check → serde deserialization → validator call. Serde failures map to generic `INVALID_ARGUMENT` with no raw input in the message; byte-limit failures map to `LIMIT_EXCEEDED`. Validators remain permissive. The temporary Rust/TypeScript `UNIMPLEMENTED` code and process/scaffold commentary were removed. Main's first green run then showed the page fixture failing during serde deserialization; the cause and diagnostic follow-up are recorded below. Current gate: **NEEDS_DIAGNOSTIC_RUN**.

Positive test selectors:

- `vfs::ink::tests::ink_parse_manifest_fixture_succeeds`
- `vfs::ink::tests::ink_parse_page_fixture_succeeds`
- `vfs::ink::tests::ink_manifest_fixture_round_trip_preserves_wire_contract`
- `vfs::ink::tests::ink_page_fixture_round_trip_preserves_wire_contract`

Use the fully scoped selector so unrelated tests with `ink_` in their names are excluded: `cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib vfs::ink::tests`.

No tests, builds, or installs were run by the implementation hand. Main verified the positive parser suite green. The current negative test batch below has not been run; no validator behavior is implemented or claimed.

## Notes

- `InkErrorCode` now contains only `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, and `UNSUPPORTED_SCHEMA`.
- `deny_unknown_fields` is declared on domain structs and internally tagged enums. No raw-`Value` key-set parsing was added.
- Main verified the positive parser suite green after the float adapter; see `docs/handwriting-annotation/verification/task-1-positive-green.log`. Main also verified the negative batch red (6 passed, 4 expected failures); see `docs/handwriting-annotation/verification/task-1-validation-red.log`.

## Follow-up: page fixture serde diagnosis

Main's `task-1-positive-green.log` showed both manifest tests passing and both page tests failing as generic `INVALID_ARGUMENT`. Inspection found `dstu-vfs` enables `serde_json/arbitrary_precision`; serde's internally tagged enum buffering calls `deserialize_any`, where serde_json emits decimal values through its private number-map representation. The page objects carry floats under `InkObjectContent`, while the manifest's floats are outside tagged enum payloads, matching the observed split.

Added narrowly scoped `deserialize_with` adapters that deserialize through `serde_json::Number` for the Ink `f64` fields (including optional `elapsed_ms`). This preserves JSON fields/tagging and enum-level `deny_unknown_fields`. The parser also rejects serde_json's reserved `$serde_json::private::Number` map key recursively before domain deserialization; this guards against accepting a forged object as a numeric value, without adding per-domain key whitelists. The positive page test retains direct `serde_json::from_slice::<InkPage>` characterization.

Main later reran the scoped positive suite successfully (exit 0); see `docs/handwriting-annotation/verification/task-1-positive-green.log`.

## Negative test batch (main red verified)

Main's scoped run reported 10 tests: 6 passed and 4 failed as expected; log: `docs/handwriting-annotation/verification/task-1-validation-red.log`. Only `src-tauri/crates/dstu-vfs/src/vfs/ink/tests.rs` was extended for that test batch. New selectors:

- `vfs::ink::tests::ink_manifest_constraints_reject_invalid_cases` — 30 rejection probes: 26 table mutations, duplicate page IDs, too many pages, and direct NaN/infinity dimensions.
- `vfs::ink::tests::ink_page_constraints_reject_invalid_cases` — 41 assertions over 40 distinct mutations: 29 table mutations, duplicate objects, object/sample budgets, a separate empty-stroke probe, and 8 direct NaN/infinity mutations.
- `vfs::ink::tests::ink_parser_rejects_malformed_trailing_and_forged_number_inputs` — 5 probes: malformed JSON, trailing value, numeric string, and forged private number-map forms in tagged and struct fields. The private-marker rejection is enforced before domain deserialization.
- `vfs::ink::tests::ink_parser_enforces_manifest_and_page_byte_limits` — 2 payloads just over 1 MiB and 8 MiB.
- `vfs::ink::tests::ink_serde_rejects_unknown_fields_on_domain_structs_and_tagged_variants` — 20 serde-only characterization cases across domain structs, every tagged content/background variant, resource source, and unit `blank` source with an extra key. Existing `deny_unknown_fields` may already make these green; they are not claimed as newly red validator behavior.
- `vfs::ink::tests::ink_manifest_and_page_accept_limit_boundaries` — 2 grouped inclusive-boundary parses covering 500 pages, dimensions 1/16384, 128-character IDs/revisions, 256-character title, 10,000 objects, 100,000 samples, 10,000-character markup-like text, and maximum width/font size.

The scoped command for main's checks is `cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib vfs::ink::tests`; this avoids unrelated repository tests containing `ink_`. The implementation hand did not run tests/build/install. Coverage remains grouped rather than independently exercising every boundary field; PDF background/source validation is only partially represented by current cases.

## Full validation implementation handoff — NEEDS_REVIEW

Implemented the brief's manifest and page validation in `src-tauri/crates/dstu-vfs/src/vfs/ink/validate.rs`: schema gates; page/dimension/ID/title/hash/source/receipt constraints; unique IDs; sample/object/text budgets; finite, ordered, bounded geometry and pressure; stroke/font/style/color limits. Validation errors use the three contract codes and generic messages without input payloads. `parse_manifest` and `parse_page` call these validators after deserialization and retain byte limits.

For `serde_json/arbitrary_precision`, page float fields continue using the `serde_json::Number` adapters. The parser first deserializes bounded bytes into `serde_json::Value`, recursively rejects serde_json's reserved `$serde_json::private::Number` key, then deserializes the value into the domain type. This rejects forged map-shaped numbers without a domain-field whitelist or wire-shape change. `InkSource::Blank` is now an empty struct variant so its existing `deny_unknown_fields` rejects extra keys while preserving `{ "kind": "blank" }` JSON. Boundary manifest fixture now updates `last_operation.result_revision` with its changed revision.

Main should run the fully scoped Ink suite and then its requested full VFS verification/review. No tests/build/install were run for this implementation. No repositories/storage/UI/operations code was changed. Known test coverage gaps remain as noted above; acceptance at every individual lower/upper bound is not independently tested. Stop here for main's implementation review.
