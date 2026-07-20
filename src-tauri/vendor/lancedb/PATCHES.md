# Local patches vs upstream `lancedb` 0.22.1

Upstream: https://github.com/lancedb/lancedb (crate `lancedb`, version 0.22.1, Apache-2.0).

This vendored copy is consumed via `[patch.crates-io]` in `src-tauri/Cargo.toml`.

## Scope of changes

**Source code: zero changes.** The only modified file is `Cargo.toml`, with
three feature trims that shrink the dependency tree (Deep Student only uses
the local-filesystem storage backend):

1. `[dependencies.lance]` — removed the `dynamodb` feature
   (`default-features = false`), dropping the DynamoDB commit-store backend
   and its AWS dependency chain.
2. `[dependencies.lance-table]` — added `default-features = false` (same
   reason: no DynamoDB/cloud commit handlers).
3. `[dependencies.object_store]` — added `default-features = false` plus
   `features = ["fs"]`, keeping only the local filesystem object store (no
   cloud provider backends). Note that `object_store` itself resolves to the
   locally patched copy in `vendor/object_store/` (see
   `vendor/object_store/PATCHES.md`).

No `.rs` file in this vendored crate differs from upstream 0.22.1.
