# Local patches vs upstream `object_store` 0.12.4

Upstream: https://github.com/apache/arrow-rs-object-store (crate `object_store`, version 0.12.4, Apache-2.0 / MIT).

This vendored copy is consumed via `[patch.crates-io]` in `src-tauri/Cargo.toml`.
All local modifications are confined to **`src/local.rs`** and are marked inline with:

```
// DEEP-STUDENT PATCH: fallback for filesystems without atomic rename/hard_link
// (e.g. exFAT); see vendor/object_store/PATCHES.md
```

## Why

Deep Student stores its Lance vector data on user-chosen locations that may be
exFAT / FAT / certain FUSE volumes. On those filesystems `std::fs::hard_link`
(and some cross-directory `std::fs::rename` calls) fail with
`PermissionDenied` / `Unsupported`, which makes upstream
`LocalFileSystem` writes fail outright. The patches add copy-based fallbacks
for exactly those two error kinds; all other behavior is unchanged.

## Patched code paths in `src/local.rs`

All five `ErrorKind::PermissionDenied | ErrorKind::Unsupported` fallback
branches below are additions relative to upstream 0.12.4 (upstream has no such
fallbacks):

1. **`put_opts` → `PutMode::Overwrite`** — when `rename(staging, path)` fails,
   fall back to copying the staged upload. The copy goes through
   `copy_via_staged_rename` (see below) instead of copying directly onto the
   destination.
2. **`put_opts` → `PutMode::Create`** — when `hard_link(staging, path)` fails,
   first claim the destination with `OpenOptions::create_new(true)` so an
   existing object still surfaces as `AlreadyExists` (preserving the
   create-exclusive semantics Lance's optimistic concurrency control relies
   on), then atomically `rename` the staged file (already a sibling of the
   destination) over the zero-byte placeholder. On rename failure the
   placeholder is rolled back and the error returned.
3. **`copy`** — when `hard_link(from, staged)` fails, copy `from` to the staged
   sibling of `to` and then `rename` it into place (this branch used the
   staged+rename shape from the beginning; only the patch marker comment was
   added).
4. **`rename`** — when `rename(from, to)` fails, copy through
   `copy_via_staged_rename` and then delete `from` (previously copied directly
   onto `to`, which was not atomic).
5. **`copy_if_not_exists`** — when `hard_link(from, to)` fails, claim the
   destination with `create_new(true)` (existing object → `AlreadyExists`,
   matching upstream semantics), then copy through `copy_via_staged_rename`.
   Previously this branch copied directly onto `to`, losing both atomicity and
   the if-not-exists exclusivity contract.

### Helper: `copy_via_staged_rename`

A private helper added near `staged_upload_path`. It copies the source to a
hidden staged file **in the same directory as the destination** (named
`{dest}#{pid}{nanos}`, staying inside the `#\d+` staging namespace that list
operations already ignore) and then `rename`s it into place. Same-directory
rename is generally supported even on filesystems where `hard_link` is not
(e.g. exFAT), so the destination never observes a partially written file — a
direct `std::fs::copy` onto the destination could leave a truncated object
(e.g. a corrupt Lance manifest) if the process crashes mid-copy. If the final
rename fails, the staged file is removed and the error propagated.

## History

- Initial patch set: plain `std::fs::copy` fallbacks on the five paths above,
  to make Lance work on exFAT.
- Atomicity revision (this iteration): route the fallbacks through a staged
  temp file + same-directory rename, and restore create-exclusive semantics
  (`AlreadyExists`) for `PutMode::Create` and `copy_if_not_exists` via an
  explicit `create_new` pre-claim.

No other files in this vendored crate are modified.
