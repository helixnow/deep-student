---
phase: 04-content-surface-adaptation
plan: 01
subsystem: ui
tags: [responsive, content-surface, thread-canvas, settings-panel, safe-area, touch]

requires:
  - phase: 02-root-state-and-layout-tokens
    provides: root responsive datasets and shared layout tokens
  - phase: 03-shell-and-sidebar-adaptation
    provides: stable compact drawer and desktop shell behavior
provides:
  - ThreadCanvas content and composer geometry now consume workspace, composer, gutter, and safe-area tokens.
  - Compact composer keeps textarea and send as the primary path while secondary actions wrap without displacing send.
  - SettingsPanel remains one shared page with token width, compact tabs, switch rows, dense cards, and viewport-safe dialogs.
  - AppChrome settings scroll gutters now consume layout and safe-area tokens.
affects: [phase-5-touch-targets-and-verification]

tech-stack:
  added: []
  patterns:
    - Content surfaces consume root layout tokens through small local style contracts.
    - Settings switches use a local label-linked row helper instead of rewriting the global Switch primitive.
    - Dense settings data keeps desktop table density and adds compact definition-list cards below desktop.

key-files:
  modified:
    - src/components/content/ThreadCanvas.tsx
    - src/components/content/ThreadCanvas.source.test.ts
    - src/components/content/SettingsPanel.tsx
    - src/components/content/SettingsPanel.source.test.ts
    - src/components/shell/AppChrome.tsx
    - src/components/shell/AppChrome.source.test.ts

key-decisions:
  - "Use existing `--workspace-max-width`, `--composer-max-width`, `--page-gutter-inline`, and safe-area tokens rather than adding new mobile/tablet token families."
  - "Keep `Switch` and `Tabs` primitives unchanged; satisfy compact settings behavior through local SettingsPanel classes and helpers."
  - "Preserve the desktop embedding dimensions table while adding compact labeled cards below `lg`."

patterns-established:
  - "Tokenized content shells: outer shell owns safe-area gutters; inner column owns max-width token."
  - "SettingsSwitchRow: label-linked touch row that keeps Radix Switch as the actual control."
  - "Dense responsive fallback: `lg:hidden` definition cards plus `hidden lg:block` desktop table."

requirements-completed: [TOKN-03, THRD-01, THRD-02, THRD-03, THRD-04, THRD-05, SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-06]

duration: 28min
completed: 2026-04-23
---

# Phase 4: Content Surface Adaptation Summary

**Token-driven ThreadCanvas and SettingsPanel surfaces that stay shared across phone, tablet, and desktop.**

## Performance

- **Duration:** 28 min
- **Started:** 2026-04-23T04:52:00Z
- **Completed:** 2026-04-23T05:19:41Z
- **Tasks:** 6
- **Files modified:** 6 source/test files plus planning metadata

## Accomplishments

- Replaced ThreadCanvas hard-coded content/composer width and page padding with `--workspace-max-width`, `--composer-max-width`, `--page-gutter-inline`, `--page-gutter-block`, and safe-area tokens.
- Kept composer as one shared component while making secondary actions wrap in a `min-w-0 flex-1` region and keeping the send button `shrink-0`.
- Tokenized SettingsPanel content width and AppChrome settings scroll left/right gutters.
- Added compact full-width/equal-width language and theme tabs.
- Added `SettingsSwitchRow` with label-linked switch ids and `min-h-[var(--touch-target-size)]`.
- Added compact embedding dimension cards as `dl` rows while preserving the desktop six-column table at `lg` and above.
- Made settings preview dialogs viewport-safe with `100dvh`, safe-area max height, overflow scrolling, and compact padding.

## Task Commits

1. **Tasks 01-02: Tokenize ThreadCanvas and make composer input-first** - `0e24a27` (feat)
2. **Tasks 03-05: Tokenize settings width/gutters, tabs/switches, dense fallback, and dialogs** - `3c35e6b` (feat)

## Files Created/Modified

- `src/components/content/ThreadCanvas.tsx` - Uses tokenized content/composer shells and compact-safe secondary composer actions.
- `src/components/content/ThreadCanvas.source.test.ts` - Locks token usage, safe-area gutters, composer action structure, and absence of old desktop constants.
- `src/components/content/SettingsPanel.tsx` - Adds token content width, compact tabs, switch rows, dense cards, and viewport-safe dialogs.
- `src/components/content/SettingsPanel.source.test.ts` - Locks single-page settings structure, compact tabs, switch rows, dense fallback, and dialog safety.
- `src/components/shell/AppChrome.tsx` - Tokenizes settings scroll left/right gutters with safe-area support.
- `src/components/shell/AppChrome.source.test.ts` - Locks settings scroll token usage while preserving shell contracts.

## Decisions Made

- Used existing layout tokens only; no new CSS token family was needed.
- Kept global `Tabs` and `Switch` primitives unchanged to avoid Phase 5 control-scope creep.
- Used compact `dl` cards for dense settings data so phone/tablet users see labels beside values instead of relying on squeezed column headers.
- Grouped commits by tightly coupled surface area rather than one commit per individual plan task.

## Deviations from Plan

Implementation scope matched the plan. Commit granularity was grouped into two cohesive commits instead of six task-level commits because tasks 01-02 share the same ThreadCanvas structure and tasks 03-05 share the same SettingsPanel/AppChrome surface. All task acceptance criteria and plan-level verification passed.

## Issues Encountered

- The first ThreadCanvas source-test run failed because the React import changed from `useState` to `type CSSProperties, useState`. The assertion was updated and the full ThreadCanvas source test passed before committing.

## User Setup Required

None - no external service configuration required.

## Verification

- `node --test --experimental-strip-types src/components/content/ThreadCanvas.source.test.ts src/components/content/SettingsPanel.source.test.ts src/components/shell/AppChrome.source.test.ts src/styles/app.source.test.ts src/lib/responsive-env.test.ts src/lib/app-layout-policy.test.ts` - passed, 71 tests.
- `npm run lint` - passed.
- `npm run build` - passed.
- `rg "MobileThreadCanvas|MobileSettingsPanel|--mobile-(page|workspace|composer|sidebar|touch)|--tablet-(page|workspace|composer|sidebar|touch)" src` - no matches, expected `rg` exit code 1.
- `rg "max-w-\\[44rem\\]|max-w-\\[46rem\\]|px-4 pb-6 pt-3 md:px-8|px-6 pb-10 md:px-20" src/components` - no matches, expected `rg` exit code 1.

## Next Phase Readiness

Phase 5 can now audit global control touch sizing and manual viewport/device acceptance on top of tokenized content surfaces. Real WebView keyboard behavior still needs Phase 5/manual validation.

## Self-Check: PASSED

- Phase 4 requirements completed: `TOKN-03`, `THRD-01`, `THRD-02`, `THRD-03`, `THRD-04`, `THRD-05`, `SETT-01`, `SETT-02`, `SETT-03`, `SETT-04`, `SETT-05`, `SETT-06`.
- `ThreadCanvas` and `SettingsPanel` stayed shared; no mobile forks or new UI libraries were introduced.
- Desktop shell/sidebar/titlebar contracts remained protected by existing AppChrome source tests.

---
*Phase: 04-content-surface-adaptation*
*Completed: 2026-04-23*
