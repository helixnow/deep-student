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

| Gate | Result |
| --- | --- |
| `npm ci` | Passed; 1,192 packages installed from the lockfile. |
| `npm run typecheck` | Passed after `npm run version:generate` created the gitignored `src/version.ts` required by the repository's CI flow. |
| `npx vite build` | Passed in 1m 6s; emitted only existing chunk/circular-import warnings. |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Passed with 22 existing Rust warnings. |

The Rust gate required environment prerequisites rather than source fixes: stable Rust 1.98 (the initial Cargo 1.83 cannot parse the locked Rust 2024 dependencies), the Linux packages listed by the repository's CI workflow, and `bash scripts/download-pdfium.sh linux-x64` for the gitignored PDFium shared library. No dependency lockfile or application source was changed for these prerequisites.
