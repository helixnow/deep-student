# Closure: Ink source resource ID (exportPDF "Source resource is missing")

## Symptom

Android menu `HandwriteAnnotations` on `exportPDF` fails with `Source resource is missing`.
DB state is valid: `files.id = file_5RbR-TvwaI`, linked `resources.id = res_xQWmQJAp_Y`,
`resources.source_table = 'files'`, `resources.source_id = file_5RbR-TvwaI`, active.

## Root cause

`vfs_ink_prepare` resolves `source_resource_id` strictly as `resources.id`
(`src-tauri/src/ink_jobs.rs`, `load_source_bytes`). The frontend passed
`DstuNode.resourceId`, but for file nodes that field is the content hash, not the
managed VFS resource ID:

- `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:438`
  `DstuNode::resource(&file.id, ..., &file.sha256)` — the last argument is
  `resource_id`, so `resourceId` becomes the SHA-256 content hash.
- Runtime proof: `dstu_get(file_ZVqHM2A1Bd)` returned
  `resourceId = b77097609e8902da3767740968657d596309ac7dc57a116ee2ae87039aa7aa58`,
  `metadata.sha256` identical, `sourceId = file_ZVqHM2A1Bd`. Real linked resource:
  `res_WNCNPp56w5`.

Therefore the prepare call received a hash where a `res_` ID was required, and the
strict backend lookup correctly rejected it.

## Fix

`src/features/ink/actions.ts` now resolves the canonical managed ID before prepare:

- new call: `vfsFileApi.get(node.sourceId || source.id).resourceId`
  (`src/api/vfsFileApi.ts` → `vfs_get_file`,
  `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs`), which returns
  `files.resource_id`.
- `node.resourceId` is never forwarded as `source_resource_id`.
- Missing managed ID → return `false`, no prepare invocation.

Rust `vfs_ink_prepare` is unchanged: it still requires a strict `resources.id`
and matching source hash; no arbitrary IDs are accepted.

`vfs_get_resource_refs` is not a usable resolver: `ref_handlers.rs` builds
`VfsResourceRef` with `resource_id: None`.

## Tests and exact state

`src/features/ink/__tests__/actions.test.ts` models the runtime shape
(`node.resourceId` = 64-char hash, `sourceId` = file ID) and expects the prepare
request to carry the resolved `res_` ID, plus a missing-managed-ID negative case.

`src/features/learning-hub/components/__tests__/LearningHubContextMenu.ink.test.tsx`
was updated for the same semantics (it exercises `prepareSourceInk` through the menu).

Commands run locally:

```
# before actions.ts fix, test file only:
npx vitest run src/features/ink/__tests__/actions.test.ts
# exit 1, 1 file failed, 2 tests failed (RED observed)

# after actions.ts fix:
npx vitest run src/features/ink/__tests__/actions.test.ts \
  src/features/learning-hub/components/__tests__/LearningHubContextMenu.ink.test.tsx
# exit 0, 2 files passed, 3 tests passed
```

Current state: `actions.ts` and both test files are implemented; the suite above
passes. The runtime failure `SOURCE_CHANGED` / "Source resource is missing" with a
valid `resources` row is the bug proof that the hash was being sent as the ID.

Process deviation: a later coordinator-run RED attempt (`closure-source-id-red-r1`)
executed against the already-fixed `actions.ts` and therefore passed 2/2; it is not
an independent RED. The RED evidence is the local pre-fix run above (2 failed),
after which `actions.ts` was edited. No Rust code was changed.


## Follow-up / risk

The underlying DSTU contract remains wrong globally: `file_to_dstu_node` puts the
content hash in `resourceId`. This change avoids it in the Ink path only; other
consumers reading `DstuNode.resourceId` for file nodes can still receive a hash.
APK must be rebuilt with the updated frontend for the runtime fix to apply.
