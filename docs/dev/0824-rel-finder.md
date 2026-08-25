# 0824 release finder / Composer persistence audit

Date: 2026-08-25

## Scope and baseline

- Upgrade source inspected: tag `v0.9.44`.
- Integration baseline: `origin/cursor/0824-cde6` at `64b0e76d`.
- Work branch: `cursor/0824-rel-finder-cde6`.
- F surfaces inspected: Finder host buckets, workbench persisted settings/snapshot, and
  split `Composer*` / InputBar session restoration.

The v0.9.44 Finder payload is a Zustand envelope at `learning-hub-finder`:

```json
{
  "state": {
    "viewMode": "grid",
    "sortBy": "updatedAt",
    "sortOrder": "desc",
    "quickAccessCollapsed": false
  },
  "version": 0
}
```

`hostId` was not persisted in v0.9.44. This is expected: missing/undefined
`hostId` resolves to the `default` bucket, whose key remains exactly
`learning-hub-finder`. The Files workbench host intentionally shares that bucket.

## Bugs found and fixes

### 1. Finder rejected values could return during Zustand hydration

`resolveInitialViewPreferences` caught storage access and JSON parse failures, but
Zustand then read the same payload again and applied its default shallow merge.
Structurally valid JSON with wrong field types could therefore overwrite the
defensive initial state. It could also hydrate fields outside the preference
allowlist if a stale payload contained them.

Fix (`9176740b`):

- whitelist each persisted enum/boolean;
- use the same sanitizer for the eager legacy read and Zustand's `merge`;
- keep the v0.9.44 singleton key and seed new host keys from its valid preferences;
- never hydrate navigation, search, selection, or data-list state.

### 2. Workbench setting JSON trusted nested field types

Workbench startup and settings UI only checked that parsed JSON was an object.
For example, an imported/corrupt image wallpaper with a non-string `value` could
reach `WallpaperLayer` string operations, while invalid tile-margin fields could
reach layout math.

Fix (`9176740b`):

- parse both local/backend JSON and live settings events through one boundary;
- validate wallpaper `kind` and string `value`;
- independently validate and clamp image blur/dim/vignette;
- validate tile-margin booleans and clamp finite margins to 0–32;
- preserve valid v0.9.44 values field-for-field.

Workbench window snapshots already had version migration, record whitelisting,
duplicate filtering, geometry validation, and read/parse exception handling; no
additional snapshot migration was needed.

### 3. Old InputBar state was only partially protected

The existing restore path filtered retired v0.9.44 panel keys
(`rag`/`search`/`learn`), but it still trusted `inputValue` to be a string.
Malformed/imported session state could reach `.trim()`/`.slice()` in the split
Composer and crash. Missing current panel keys also needed an explicit defaulting
contract.

Separately, Rust `PanelStates` still modeled the retired keys but omitted the
current `skill` key. Serde silently discarded `skill` on save, so that Composer
panel state was lost on round trip.

Fix (`0a6344e1`):

- normalize persisted composer state from `unknown`;
- preserve valid v0.9.44 draft text and still-current panel booleans;
- default missing current keys and drop retired/non-boolean keys;
- reject non-string drafts before render;
- add `skill` to the Rust schema while retaining old optional fields, so old rows
  still deserialize and new rows round-trip the current panel.

## IndexedDB result

There is no application Finder, workbench, or Composer IndexedDB persistence in
this tree. The only direct `indexedDB` use is the developer “clear cache” command,
which enumerates and deletes databases. Chat InputBar state is stored in the
Tauri SQLite session-state table (plus session-scoped text in `sessionStorage`);
Finder/workbench browser fallbacks use `localStorage`. No IndexedDB migration was
required.

## Regression coverage and verification

- Finder host/default-key mapping, exact v0.9.44 payload inheritance, corrupt
  values, and the second Zustand hydration merge.
- Workbench valid legacy JSON, malformed wallpaper shapes, optional image fields,
  and partial/clamped tile margins.
- Composer v0.9.44 draft/panel shape, missing keys, retired keys, malformed
  drafts, and scalar/null payloads.
- Rust old-shape deserialization and current `skill` round trip.

Results:

- Targeted Vitest: 3 files, 26 tests passed.
- `npm run version:generate && npm run typecheck`: passed.
- `cargo fmt -- --check` with stable Rust: passed.
- Rust unit-test build reached the application build script but could not run in
  this worktree because the bundled `src-tauri/resources/pdfium/libpdfium.so`
  asset is absent. This is an environment/resource precondition, not a compile
  diagnostic from the changed schema.
