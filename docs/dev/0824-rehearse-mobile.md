# 0824 mobile merge rehearsal

Date: 2026-08-24

## Scope

- Base: `origin/cursor/0824-cde6` at `8361e6b7`
- Merged theme repository G: `origin/cursor/0824-theme-mobile-cde6` at `4ab24435`
- Rehearsal branch: `cursor/0824-rehearse-mobile-cde6`
- Excluded: theme repositories from #176 and #268
- The shared `cursor/0824-cde6` branch is not modified or pushed by this rehearsal.

## Conflict resolution

### `IndexStatusView`

The base branch adds `IndexStatusGenerativeBriefing`, while mobile changes the resource area to own its scrolling through `CustomScrollArea` and removes the obsolete sticky filter behavior.

The resolution keeps the briefing wired to the live index summary, batch-index action, and refresh action. It is mounted as a non-shrinking sibling immediately before the filter bar, while the filter and resource list retain mobile's new non-sticky/independent-scroll structure.

### `VendorSidebar`

The conflict mixed the base branch's extracted dnd-kit `SortableVendorRow` implementation with an older inline draggable-row renderer. The resolution keeps the dnd-kit component path and its shared `handleSelectVendor` callback, including mobile detail navigation. This avoids restoring the superseded inline renderer and duplicate drag behavior.

## Verification gates

The final rehearsal commit records the results for:

1. `npm ci`
2. `npm run typecheck`
3. `npx vite build`
4. `cargo check --manifest-path src-tauri/Cargo.toml --lib`
