# Roadmap: study-ui Mobile Adaptation

**Created:** 2026-04-23
**Granularity:** Coarse
**Current milestone:** v1 Responsive Mobile/Tablet Adaptation

## Summary

| Phase | Name | Goal | Requirements | Status |
|-------|------|------|--------------|--------|
| 1 | Responsive Policy Foundation | Centralize responsive facts and layout decisions | RESP-01, RESP-02, RESP-03, RESP-04 | Complete |
| 2 | Root State And Layout Tokens | Expose policy state to CSS and split sidebar semantics | SHELL-01, SHELL-02, TOKN-01, TOKN-02 | Complete |
| 3 | Shell And Sidebar Adaptation | Make AppChrome/Titlebar/Sidebar work across compact and desktop modes | SHELL-03, SHELL-04, SHELL-05, SHELL-06 | Complete |
| 4 | Content Surface Adaptation | Make ThreadCanvas and SettingsPanel mobile/tablet-safe through tokens and responsive degradation | TOKN-03, THRD-01, THRD-02, THRD-03, THRD-04, THRD-05, SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-06 | Verified |
| 5 | Touch Targets And Verification | Lock controls, tests, build, and manual viewport acceptance | CTRL-01, CTRL-02, VERF-01, VERF-02, VERF-03, VERF-04, VERF-05 | UI-SPEC approved |

## Phase 1: Responsive Policy Foundation

**Goal:** Replace scattered viewport assumptions with a tested responsive environment and app layout policy.

**Status:** Verified

**UI hint:** yes

**Depends on:** None

**Requirements:** RESP-01, RESP-02, RESP-03, RESP-04

**Primary files:**

- `src/lib/responsive-env.ts`
- `src/lib/responsive-env.test.ts`
- `src/lib/app-layout-policy.ts`
- `src/lib/app-layout-policy.test.ts`
- `src/lib/app-shell.ts`
- `src/components/shell/AppChrome.tsx`

**Success criteria:**

1. A single module classifies `phone`, `tablet`, `desktop`, and `isCompact` using the agreed breakpoints.
2. A layout policy module derives sidebar mode, density, and form-factor decisions from environment state.
3. Tests cover `639`, `640`, `767`, `768`, `1023`, and `1024`.
4. `AppChrome` no longer owns a local `matchMedia("(max-width: 767px)")` policy.

## Phase 2: Root State And Layout Tokens

**Goal:** Make responsive state observable at the shell root and consumable by CSS tokens.

**Status:** Complete

**UI hint:** yes

**Depends on:** Phase 1

**Requirements:** SHELL-01, SHELL-02, TOKN-01, TOKN-02

**Primary files:**

- `src/App.tsx`
- `src/components/shell/AppChrome.tsx`
- `src/styles/app.css`
- `src/styles/app.source.test.ts`

**Success criteria:**

1. App state distinguishes mobile drawer visibility from desktop/sidebar collapsed state.
2. Shell root includes stable datasets for form factor, sidebar mode, density, and related policy state.
3. `app.css` defines reusable token names for gutters, widths, composer offset, safe-area-aware height, and touch target size.
4. Dataset-specific token overrides use the same token names rather than duplicated mobile/tablet token families.

## Phase 3: Shell And Sidebar Adaptation

**Goal:** Adapt AppChrome, Titlebar, and Sidebar while preserving desktop window behavior.

**Status:** Complete

**UI hint:** yes

**Depends on:** Phase 1, Phase 2

**Requirements:** SHELL-03, SHELL-04, SHELL-05, SHELL-06

**Primary files:**

- `src/components/shell/AppChrome.tsx`
- `src/components/shell/Titlebar.tsx`
- `src/components/shell/Sidebar.tsx`
- `src/components/shell/WindowControls.tsx`
- `src/components/shell/FramelessResizeHandles.tsx`
- `src/lib/app-shell.ts`

**Success criteria:**

1. Compact mode uses the existing `Sheet` sidebar rather than reserving desktop sidebar width.
2. Desktop mode keeps docked sidebar behavior and existing titlebar/window controls.
3. Compact navigation closes after selection where that improves mobile flow.
4. Mobile/tablet topbar keeps only core actions and does not inherit desktop-only status clutter.
5. Source tests protect desktop titlebar, window controls, and sidebar behavior from mobile regressions.

## Phase 4: Content Surface Adaptation

**Goal:** Make the main thread and settings surfaces readable, touch-friendly, and safe-area-aware across phone/tablet/desktop.

**Status:** Complete

**UI hint:** yes

**Depends on:** Phase 2, Phase 3

**Requirements:** TOKN-03, THRD-01, THRD-02, THRD-03, THRD-04, THRD-05, SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-06

**Primary files:**

- `src/components/content/ThreadCanvas.tsx`
- `src/components/content/ThreadCanvas.source.test.ts`
- `src/components/content/SettingsPanel.tsx`
- `src/components/content/SettingsPanel.source.test.ts`
- `src/components/ui/tabs.tsx`
- `src/components/ui/switch.tsx`
- `src/styles/app.css`

**Success criteria:**

1. Thread content and composer sizing consume layout tokens rather than page-local max-width/padding constants.
2. Composer uses safe-area-aware spacing and keeps input/send as the primary mobile interaction.
3. SettingsPanel stays one shared page while dense tables, tabs, and switch rows degrade cleanly under desktop widths.
4. Tests prevent reintroducing hard-coded desktop-only widths and confirm small-screen settings behavior.

## Phase 5: Touch Targets And Verification

**Goal:** Finish touch sizing, automated checks, and manual acceptance for the migration.

**Status:** UI-SPEC approved

**UI hint:** yes

**Depends on:** Phase 4

**Requirements:** CTRL-01, CTRL-02, VERF-01, VERF-02, VERF-03, VERF-04, VERF-05

**Primary files:**

- `src/components/shell/ShellButton.tsx`
- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/textarea.tsx`
- `src/components/ui/switch.tsx`
- `src/styles/app.css`
- Source/unit tests touched by earlier phases

**Success criteria:**

1. Phone/tablet controls meet the 44px hit target expectation while desktop can remain compact.
2. `npm run lint` passes.
3. `npm run build` passes.
4. Targeted source/unit tests pass for responsive policy, shell, ThreadCanvas, SettingsPanel, and app-shell behavior.
5. Manual viewport checks cover phone, tablet portrait, tablet landscape, desktop minimum, and wider desktop.

## Requirement Coverage

All v1 requirements from `.planning/REQUIREMENTS.md` are mapped to exactly one roadmap phase.

## Next Step

Run `$gsd-plan-phase 5` to create the executable touch target and verification plan.
