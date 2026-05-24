# Floating Sidebar Translucency Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers/executing-plans` to implement this plan task-by-task.

**Goal:** Refactor the Claude Code-authored shell so the left sidebar can visually reveal app page color behind it, instead of only reading as native/system window translucency.

**Architecture:** Keep `windowBackgroundPreference` as the single source of truth for opaque vs translucent behavior, but change the sidebar from a layout sibling into a floating overlay layer anchored above the main pane. Preserve native window material behavior, root transparency, titlebar geometry, and shell regression contracts while moving the visual transparency effect to the app layer.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS v4, Tauri, Radix primitives, node:test source/contract tests.

---

## Scope and Entry Chain

- [x] Read the active entry chain before editing: `src/main.tsx` -> `src/App.tsx` -> `src/components/shell/AppChrome.tsx` -> `src/components/shell/Sidebar.tsx`
- [x] Read the translucency source-of-truth files before editing:
  - [x] `src/components/theme/theme-provider.tsx`
  - [x] `src/lib/theme.ts`
  - [x] `src/lib/app-shell.ts`
  - [x] `src/lib/native-window.ts`
  - [x] `src/styles/app.css`
- [x] Read the most relevant existing plan references (do not copy blindly):
  - [x] [2026-03-10-native-window-background-design.md](docs/plans/2026-03-10-native-window-background-design.md)
  - [x] [2026-03-10-cross-platform-shell-implementation.md](docs/plans/2026-03-10-cross-platform-shell-implementation.md)

---

## Guardrails (must stay true)

- [x] Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- [x] Do not break `windowBackgroundPreference` semantics: `translucent` remains the default, `opaque` remains the explicit override.
- [x] Do not remove native window appearance syncing from `src/components/theme/theme-provider.tsx`.
- [x] Do not break macOS overlay geometry from `src/lib/app-shell.ts` and `src/components/shell/Titlebar.tsx`.
- [x] Do not reintroduce solid root backgrounds in translucent mode inside `src/styles/app.css`.
- [x] Do not convert the sidebar into a blocking full-screen modal overlay.
- [x] Keep uncovered page content visible behind the sidebar; only the sidebar surface itself should capture pointer events.
- [x] Preserve current shell behavior in opaque mode.

---

## Research Summary to Respect During Implementation

- [x] Treat these as separate concerns:
  - [x] Native translucency = Tauri window material from `src/lib/native-window.ts`
  - [x] App bleed-through = sidebar overlaying the main pane with app-layer alpha classes
- [x] Preserve these known current contracts:
  - [x] `src/styles/app.css` keeps `html`, `body`, and `#root` transparent in translucent mode
  - [x] `src/lib/app-shell.ts` keeps `bg-transparent` for macOS translucent native overlay and `bg-shell-backdrop/52` for non-mac translucent fallback
  - [x] `src/components/shell/AppChrome.tsx` keeps translucent main pane behavior distinct from opaque mode
  - [x] `src/components/shell/Sidebar.tsx` keeps translucent surface behavior distinct from opaque mode
- [x] Internal conclusion: lowering sidebar alpha alone is insufficient because the current sidebar is a sibling column, not an overlaid panel

---

## Phase 0 - Baseline Verification Before Any Refactor

- [x] Run shell/unit tests:
  - [x] `npm run test:shell`
  - [x] `npm run test:theme`
- [x] Run contract/source tests that cover window background and shell surfaces:
  - [x] `node --test scripts/window-background-visual-contract.test.mjs`
  - [x] `node --test scripts/window-background-system-effect-contract.test.mjs`
  - [x] `node --test scripts/native-window-theme-provider-contract.test.mjs`
  - [x] `node --test scripts/main-pane-depth-contract.test.mjs`
  - [x] `node --test scripts/settings-sidebar-surface-contract.test.mjs`
- [x] Run lint: `npm run lint`
- [x] Run build: `npm run build`
- [x] Record any pre-existing failures before editing anything

---

## Phase 1 - Preserve and Clarify Current Shell Contracts First

**Files:**
- Modify: `scripts/window-background-visual-contract.test.mjs`
- Modify: `scripts/main-pane-depth-contract.test.mjs`
- Modify: `scripts/settings-sidebar-surface-contract.test.mjs`
- Optional add: `scripts/floating-sidebar-contract.test.mjs`

- [x] Update or add source-contract tests so they stop hardcoding the old sibling-column implementation details and instead enforce the intended floating-sidebar outcome
- [x] Preserve assertions for:
  - [x] opaque vs translucent class switching
  - [x] root transparency in translucent mode
  - [x] main-pane depth treatment when sidebar is visible
  - [x] minimal settings-sidebar inset behavior
- [x] Add floating-sidebar-specific assertions such as:
  - [x] sidebar renders in a positioned layer above the main pane
  - [x] wrapper uses pass-through pointer-event strategy (`pointer-events-none` wrapper, `pointer-events-auto` surface)
  - [x] translucent mode still uses an alpha sidebar surface rather than a fully opaque fill
  - [x] opaque mode still renders a solid sidebar surface

**Verify:**
- [x] `node --test scripts/window-background-visual-contract.test.mjs scripts/main-pane-depth-contract.test.mjs scripts/settings-sidebar-surface-contract.test.mjs scripts/floating-sidebar-contract.test.mjs`

---

## Phase 2 - Extract Floating Sidebar Layout Policy into Shell Helpers

**Files:**
- Modify: `src/lib/app-shell.ts`
- Modify: `src/lib/app-shell.test.ts`

- [x] Add explicit shell helpers for the floating sidebar layout instead of burying geometry in JSX
- [x] Keep helpers focused and testable, for example:
  - [x] sidebar overlay width / edge inset policy
  - [x] content offset policy when the sidebar is floating vs hidden
  - [x] sidebar surface class selection for opaque vs translucent mode
  - [x] any platform-specific top/leading adjustments needed around macOS traffic lights or frameless controls
- [x] Preserve these existing contracts in tests:
  - [x] macOS `native-overlay` remains the titlebar mode on macOS
  - [x] Windows `frameless` remains the titlebar mode on Windows
  - [x] translucent shell backdrop logic remains intact
  - [x] existing safe-zone and toggle-position helpers remain valid unless intentionally revised
- [x] Add tests for any new helper introduced in this phase

**Verify:**
- [x] `npm run test:shell`

---

## Phase 3 - Convert the Sidebar from Layout Column to Floating Overlay Layer

**Files:**
- Modify: `src/components/shell/AppChrome.tsx`
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/components/shell/Titlebar.tsx`

- [x] In `src/components/shell/AppChrome.tsx`, stop relying on sidebar width as a sibling layout column
- [x] Render the sidebar in an overlay layer above the main pane instead of reserving a permanent left column
- [x] Reuse the repo's proven pass-through layering pattern already seen in these concrete files:
  - [x] `src/components/shell/AppChrome.tsx` floating toggle wrapper pattern
  - [x] `src/components/shell/Titlebar.tsx` leading accessory wrapper pattern
- [x] Reuse the repo's proven pass-through layering pattern in the new sidebar overlay:
  - [x] outer wrapper should be positioned (`absolute` or `fixed` as appropriate) with `pointer-events-none`
  - [x] actual sidebar surface should be `pointer-events-auto`
- [x] Keep the main pane mounted and visually present underneath the floating sidebar at all times
- [x] Ensure the sidebar overlay is clipped and layered intentionally relative to:
  - [x] titlebar drag region
  - [x] macOS traffic-light area
  - [x] Windows frameless controls
  - [x] resize handles from `FramelessResizeHandles`
- [x] Preserve sidebar toggle accessibility and current mode flows:
  - [x] app mode open/close
  - [x] settings mode
  - [x] return-to-app flow
- [x] Keep the sidebar width visually consistent with the current `w-72` shell unless a tested helper replaces it
- [x] Preserve motion direction and timing quality without animating layout-affecting properties more than necessary

**Verify:**
- [x] `npm run lint`
- [x] `node --test scripts/window-background-visual-contract.test.mjs scripts/main-pane-depth-contract.test.mjs scripts/settings-sidebar-surface-contract.test.mjs scripts/floating-sidebar-contract.test.mjs`

---

## Phase 4 - Tune the Sidebar Surface So It Reveals App Color, Not Just System Material

**Files:**
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/components/shell/AppChrome.tsx`
- Optional modify: `src/styles/app.css`

- [x] Keep opaque mode visually solid
- [x] Keep translucent mode visually lighter than opaque mode
- [x] Adjust the translucent sidebar surface so it reveals the page/main-pane color underneath more clearly than the current sibling-column version
- [x] Do not solve this by making the sidebar unusably transparent; maintain readable text/icon contrast
- [x] If needed, add a subtle inner border, shadow, or backdrop blur that improves legibility without hiding the page color beneath
- [x] If needed, slightly rebalance the main-pane surface behind the floating sidebar so the underlay color reads as app content instead of a flat shell slab
- [x] Do not introduce gradients or flashy effects unless required for legibility

**Manual visual acceptance for this phase:**
- [x] In translucent mode, the left sidebar clearly reveals the page content color behind it
- [x] In opaque mode, the sidebar still reads as a solid shell panel
- [x] Text and icons remain readable in both light and dark themes
- [x] The effect looks intentional on both app mode and settings mode

---

## Phase 5 - Keep Native Window Material Behavior Intact

**Files:**
- Modify only if required: `src/components/theme/theme-provider.tsx`
- Modify only if required: `src/lib/native-window.ts`
- Modify only if required: `src/styles/app.css`

- [x] Do not remove `applyNativeWindowAppearance(...)` from the theme provider
- [x] Do not change native opaque/translucent platform mapping unless a failing test proves it is necessary
- [x] Preserve these test-backed behaviors:
  - [x] opaque => solid theme-matched native background, no effects
  - [x] macOS translucent => `macos-content-background`
  - [x] Windows translucent => `windows-blur`
  - [x] non-Tauri runtime => native work is skipped safely
- [x] Preserve transparent root surfaces in translucent mode
- [x] If you touch native-window logic, update tests first and prove why the change is required by the sidebar refactor

**Verify:**
- [x] `node --test src/lib/native-window.test.ts src/lib/native-window-preference.test.ts src/lib/theme.test.ts`
- [x] `node --test scripts/window-background-system-effect-contract.test.mjs scripts/native-window-theme-provider-contract.test.mjs`

---

## Phase 6 - Add or Update Source-Level Regression Tests for the New Overlay Structure

**Files:**
- Add or modify: `scripts/floating-sidebar-contract.test.mjs`
- Modify if needed: `scripts/window-background-visual-contract.test.mjs`
- Modify if needed: `scripts/main-pane-depth-contract.test.mjs`
- Modify if needed: `scripts/settings-sidebar-surface-contract.test.mjs`

- [x] Assert that `AppChrome` now contains an overlay/floating sidebar layer rather than only a reserved-width sibling column
- [x] Assert that the floating layer uses the pass-through pointer-event pattern
- [x] Assert that the main pane still receives its translucent/opaque class split correctly
- [x] Assert that settings-sidebar spacing and content grouping remain aligned with current design intent
- [x] Keep assertions string-based and source-oriented if that matches existing repo test style

**Verify:**
- [x] `node --test scripts/window-background-visual-contract.test.mjs scripts/main-pane-depth-contract.test.mjs scripts/settings-sidebar-surface-contract.test.mjs scripts/floating-sidebar-contract.test.mjs`

---

## Phase 7 - End-to-End Verification for This Refactor

- [x] Run all relevant unit tests together:
  - [x] `npm run test:shell`
  - [x] `npm run test:theme`
  - [x] `node --test src/lib/native-window.test.ts src/lib/native-window-preference.test.ts`
- [x] Run all relevant contract/source tests together:
  - [x] `node --test scripts/window-background-visual-contract.test.mjs scripts/window-background-system-effect-contract.test.mjs scripts/native-window-theme-provider-contract.test.mjs scripts/main-pane-depth-contract.test.mjs scripts/settings-sidebar-surface-contract.test.mjs scripts/floating-sidebar-contract.test.mjs`
- [x] Run diagnostics/lint/build:
  - [x] `npm run lint`
  - [x] `npm run build`
- [x] Start the desktop shell for real translucency verification:
  - [x] `npm run tauri:dev`
- [x] Open the existing window-background control in `src/components/content/SettingsPanel.tsx` and verify both modes via the UI toggle:
  - [x] translucent
  - [x] opaque
- [x] Manually verify in app mode:
  - [x] sidebar open in translucent mode shows app color behind it
  - [x] sidebar open in opaque mode stays solid
  - [x] closing/opening sidebar does not break titlebar controls or drag regions
- [x] Manually verify in settings mode:
  - [x] settings sidebar still feels anchored and readable
  - [x] settings content remains visible behind the floating shell treatment where intended
- [ ] Manually verify on both macOS-style overlay and Windows frameless logic paths if available

---

## Rollback / Failure Conditions

- [ ] Revert the floating conversion if any of these happen:
  - [ ] macOS traffic-light alignment regresses
  - [ ] root translucency contracts fail
  - [ ] native window effect tests fail
  - [ ] sidebar becomes modal/blocking rather than pass-through
  - [ ] page color still does not visually read behind the sidebar after the layout refactor
- [ ] If rolling back, keep any helpful contract tests that correctly describe the desired end state, but do not leave production shell code half-converted

---

## Implementation Notes for the LLM

- [x] Start from structure, not opacity numbers
- [x] Prefer a floating shell layer based on existing repo patterns (`pointer-events-none` wrapper + `pointer-events-auto` child) over introducing a modal `Sheet`
- [x] Use existing tokens/classes first; only introduce new helpers or tests when the current structure cannot express the desired behavior cleanly
- [x] Keep the implementation small and local to the shell unless a test proves wider changes are required
