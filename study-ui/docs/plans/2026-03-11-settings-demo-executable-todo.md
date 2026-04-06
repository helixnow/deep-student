# Settings Demo Optimization (Claude Code) — Executable TODO

**Target:** Improve the Claude Code-authored Settings Demo so it is safer (no timer leaks), easier to maintain (split + data-driven), and more trustworthy as a regression surface (less drift, clearer primitive fidelity).

**Entry chain (do not break):** `src/main.tsx` -> `src/App.tsx` (`demo` tab) -> `src/components/content/SettingsPanel.tsx` -> `src/components/content/SettingsDemoPanel.tsx`

**Primary files:**
- `src/components/content/SettingsDemoPanel.tsx`
- `src/components/content/SettingsPanel.tsx`
- `src/lib/settings-panel.ts`

**Existing references (read, don’t copy-paste):**
- [2026-03-10-settings-demo-page.md](docs/plans/2026-03-10-settings-demo-page.md)
- [2026-03-11-settings-demo-optimization.md](docs/plans/2026-03-11-settings-demo-optimization.md)

**Existing tests (keep passing):**
- `src/App.demo.source.test.ts`
- `src/lib/settings-panel.test.ts`
- `src/components/content/SettingsDemoPanel.source.test.ts`

---

## Guardrails (must follow)

- [x] No type suppression (`as any`, `@ts-ignore`, `@ts-expect-error`).
- [x] No behavior changes outside Demo unless explicitly required by the plan.
- [x] Keep Demo reachable via `src/App.tsx` `id: "demo"` / `label: "组件 Demo"`.
- [x] Prefer extracting code over duplicating constants.
- [x] Every phase ends with verification commands listed in that phase.

---

## Phase 0 — Baseline verification (before edits)

- [x] Run: `node --test src/App.demo.source.test.ts src/lib/settings-panel.test.ts src/components/content/SettingsDemoPanel.source.test.ts`
- [x] Run: `npm run lint`

Verification log:
- `node --test src/App.demo.source.test.ts src/lib/settings-panel.test.ts src/components/content/SettingsDemoPanel.source.test.ts` - pass (`8` tests passed, `0` failed)
- `npm run lint` - pass (ESLint completed with no reported errors)

---

## Phase 1 — Fix lifecycle safety first (toast timer cleanup)

**Why:** `SettingsPanel` conditionally mounts the demo (`src/components/content/SettingsPanel.tsx:1030`). A pending timeout can fire after unmount.

- [x] Add an explicit unmount cleanup for the toast timeout in `src/components/content/SettingsDemoPanel.tsx`.
- [x] Ensure repeated toast triggers still clear the prior timer.
- [ ] Decide toast scope:
  - [x] Option A (recommended): keep toast preview visually scoped to the demo card/surface.
  - [ ] Option B: keep viewport-fixed toast but document that it intentionally tests global overlay behavior.

**Verify:**
- [x] Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
- [x] Run: `npm run lint`

Verification log:
- `node --test src/components/content/SettingsDemoPanel.source.test.ts` - pass (`3` tests passed, `0` failed)
- `npm run lint` - pass (ESLint completed with no reported errors)

---

## Phase 2 — Split the monolith into sections + data

**Goal:** Make `SettingsDemoPanel` primarily composition, not 600+ lines of inline JSX.

- [x] Create: `src/components/content/settings-demo-data.ts`
  - [x] Move constant fixtures (e.g. combobox suggestions) into this file.
  - [x] Move demo section metadata (title/description keys) into this file.
- [x] Create: `src/components/content/settings-demo-sections.tsx`
  - [x] Extract presentational section components (no local state).
  - [x] Keep section APIs simple: props are data + callbacks.
- [x] Modify: `src/components/content/SettingsDemoPanel.tsx`
  - [x] Keep only: page header + section composition + small glue.
  - [x] Keep local helpers only if they are truly demo-only and small.

**Verify:**
- [x] Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
- [x] Run: `npm run lint`

Verification log:
- `node --test src/components/content/SettingsDemoPanel.source.test.ts` - pass (`3` tests passed, `0` failed)
- `npm run lint` - pass (ESLint completed with no reported errors)

---

## Phase 3 — Remove preview drift (shared fixtures, no duplicated nav)

**Problem today:** demo sidebar preview duplicates nav labels/icons (`sidebarPreviewItems`) instead of deriving from real app sources (`src/App.tsx`).

- [x] Create: `src/lib/demo-fixtures.tsx`
  - [x] Export a single source for demo preview nav + thread fixtures.
  - [x] Prefer deriving the demo nav subset from the same structure used in `src/App.tsx` (or exporting the nav list from `src/App.tsx` into a small shared module).
- [x] Modify: `src/components/content/SettingsDemoPanel.tsx`
  - [x] Replace in-file `sidebarPreviewItems` / `sidebarPreviewThreads` with imports.
  - [x] Make sidebar preview scrollable inside a bounded container instead of hard clipping content.

**Verify:**
- [x] Run: `node --test src/App.demo.source.test.ts src/components/content/SettingsDemoPanel.source.test.ts`
- [x] Run: `npm run lint`

Verification log:
- `node --test src/App.demo.source.test.ts src/components/content/SettingsDemoPanel.source.test.ts` - pass (`5` tests passed, `0` failed)
- `npm run lint` - pass (ESLint completed with no reported errors)

---

## Phase 4 — Make primitive fidelity explicit (real primitives vs mock patterns)

**Intent:** The demo should reflect what is actually reusable. Today some sections are raw markup (e.g. native `<select>`, `<datalist>`, custom toast/skeleton).

- [x] Audit and label sections:
  - [x] Keep “real shared primitive” sections (Button/Input/Textarea/Dialog/Sheet/Tabs/Tooltip/Dropdown) as-is.
  - [x] For “mock-only” patterns (Select/Combobox/Toast/Skeleton/Empty/ListItem): either implement shared primitives or relabel the demo section titles/descriptions to say “Example / Mock”.
- [x] Replace demo-only surface wrapper:
  - [x] Prefer `src/components/ui/surface.tsx` instead of the local `MiniSurface` helper where possible.

**Verify:**
- [x] Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
- [x] Run: `npm run lint`

Verification log:
- `node --test src/components/content/SettingsDemoPanel.source.test.ts` - pass (`4` tests passed, `0` failed)
- `npm run lint` - pass (ESLint completed with no reported errors)

---

## Phase 5 — Strengthen source tests to prevent regressions

**Goal:** Current tests are mostly string-presence. Add structural assertions that match the refactor.

- [x] Update: `src/components/content/SettingsDemoPanel.source.test.ts`
  - [x] Assert new module files exist.
  - [x] Assert `SettingsDemoPanel.tsx` imports section/data modules (to prevent future re-monolith).
- [x] Update: `src/components/content/SettingsPanel.source.test.ts`
  - [x] Add a source assertion that the demo handoff exists (conditional render of `SettingsDemoPanel`).

**Verify:**
- [x] Run: `node --test src/components/content/SettingsPanel.source.test.ts src/components/content/SettingsDemoPanel.source.test.ts`
- [x] Run: `npm run lint`

Verification log:
- `node --test src/components/content/SettingsPanel.source.test.ts src/components/content/SettingsDemoPanel.source.test.ts` - pass (`9` tests passed, `0` failed)
- `npm run lint` - pass (ESLint completed with no reported errors)

---

## Phase 6 — Full verification (ship-ready)

- [x] Run: `node --test src/App.demo.source.test.ts src/lib/settings-panel.test.ts src/components/content/SettingsPanel.source.test.ts src/components/content/SettingsDemoPanel.source.test.ts`
- [x] Run: `npm run lint`
- [x] Run: `npm run build`

Verification log:
- `node --test src/App.demo.source.test.ts src/lib/settings-panel.test.ts src/components/content/SettingsPanel.source.test.ts src/components/content/SettingsDemoPanel.source.test.ts` - pass (`16` tests passed, `0` failed)
- `npm run lint` - pass (ESLint completed with no reported errors)
- `npm run build` - pass (production build succeeded; Vite emitted a non-blocking chunk-size warning for `dist/assets/index-*.js`)
