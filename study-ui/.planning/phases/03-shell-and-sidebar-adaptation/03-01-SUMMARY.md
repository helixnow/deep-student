---
phase: 03-shell-and-sidebar-adaptation
plan: 01
subsystem: ui
tags: [responsive, shell, sidebar, compact, desktop-preservation]

requires:
  - phase: 01-responsive-policy-foundation
    provides: ResponsiveEnvironment and AppLayoutPolicy
  - phase: 02-root-state-and-layout-tokens
    provides: split sidebar state and shell root datasets
provides:
  - Compact app header hides desktop status noise and keeps a core new-conversation action.
  - Compact sidebar uses the existing Sheet drawer and closes after meaningful navigation selections.
  - Desktop docked sidebar, titlebar, resize handles, and window controls remain preserved by source tests.
affects: [phase-4-content-surface-adaptation, phase-5-touch-targets-and-verification]

tech-stack:
  added: []
  patterns:
    - AppChrome routes compact vs desktop shell behavior from AppLayoutPolicy.
    - Sidebar owns a compact-only close-after-selection contract through closeOnSelect.
    - Folder disclosure remains separate from final navigation selection.

key-files:
  modified:
    - src/components/shell/AppChrome.tsx
    - src/components/shell/AppChrome.source.test.ts
    - src/components/shell/Sidebar.tsx
    - src/components/shell/Sidebar.source.test.ts
    - src/components/shell/sidebar-settings.test.ts

requirements-completed: [SHELL-03, SHELL-04, SHELL-05, SHELL-06]

duration: 22min
completed: 2026-04-23
---

# Phase 3: Shell And Sidebar Adaptation Summary

**The shared shell now behaves correctly across compact drawer and desktop docked modes without forking the UI.**

## Accomplishments

- Kept compact navigation in the existing `Sheet`/`Sidebar` path.
- Added `closeOnSelect` to `Sidebar` and passed it from AppChrome only when `sidebarMode === "drawer"`.
- Closed compact drawer after primary entry, pinned/recent thread, return-to-app, and inactive settings tab selections.
- Kept folder disclosure rows open because expanding a group is not final navigation.
- Replaced compact topbar desktop status clutter with a single core `新建对话` icon action.
- Preserved desktop docked sidebar, macOS traffic-light accessory gating, resize handles, and Windows custom controls.
- Updated source tests for compact topbar gating, drawer close-on-select behavior, and settings nav handler routing.

## Task Commits

1. **Pre-flight fallback planning** - `d170a16` (docs)
2. **Task 1: Simplify compact app header actions** - `e91b923` (feat)
3. **Task 2: Close compact sidebar after navigation** - `5641fa0` (feat)
4. **Task 2 test follow-up: Update sidebar settings navigation contract** - `ac1fd87` (test)

## Verification

- `node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/components/shell/sidebar-settings.test.ts src/components/shell/Titlebar.source.test.ts src/lib/app-shell.test.ts src/lib/responsive-env.test.ts src/lib/app-layout-policy.test.ts` - passed, 91 tests.
- `npm run lint` - passed.
- `npm run build` - passed.
- `git diff -- src/components/content/ThreadCanvas.tsx src/components/content/SettingsPanel.tsx` - empty.

## Notes

- A broader exploratory test command that also included `ShellButton.source.test.ts` surfaced a pre-existing stale assertion in that test file. It was not part of the Phase 3 plan-level verification and was not caused by Phase 3 code changes.
- Phase 4 can now adapt `ThreadCanvas` and `SettingsPanel` on top of stable compact shell behavior.

## Self-Check: PASSED

- Phase 3 requirements completed: `SHELL-03`, `SHELL-04`, `SHELL-05`, `SHELL-06`.
- Code changes stayed within shell/sidebar scope.
- Content surface files were not modified.

---
*Phase: 03-shell-and-sidebar-adaptation*
*Completed: 2026-04-23*
