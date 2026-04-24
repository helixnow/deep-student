---
phase: 7
plan: 07-01
subsystem: deepstudent-migration-foundation
tags:
  - ui
  - tokens
  - primitives
  - mobile-shell
key-files:
  - src/styles/shadcn-variables.css
  - src/styles/theme-colors.css
  - src/components/ui/buttonPrimitiveContract.ts
  - src/components/ui/NotionButton.tsx
  - src/components/ui/shad/Button.tsx
  - src/components/layout/MobileHeader.tsx
  - src/components/layout/UnifiedMobileHeader.tsx
  - src/components/layout/MobileSidebarNavigation.tsx
  - src/components/ui/unified-sidebar/*
  - src/components/ui/__tests__/migrationFoundation.source.test.ts
metrics:
  tests: 5 source guard tests
  build: passed
  lint: targeted passed
---

# Plan 07-01 Summary: DeepStudent Migration Foundation

## What Changed

- Added a parent-app token bridge for the missing `study-ui` button density aliases: `--button-height*`, `--button-padding-x*`, tonal/outline/destructive button colors, and canonical `--touch-target-size` usage.
- Added `src/components/ui/buttonPrimitiveContract.ts` as the shared primitive contract for base button chrome, tone classes, touch-safe sizes, shell nav rows, and shell icon buttons.
- Refactored `NotionButton` and `src/components/ui/shad/Button.tsx` to consume the same shared contract instead of maintaining separate size/tone behavior.
- Updated `Input`, `Switch`, `Button.css`, mobile headers, mobile sidebar navigation, drawer/layout close controls, and unified-sidebar internal controls to keep 44px touch targets below `lg`.
- Replaced migrated shell/internal sidebar Lucide imports with Phosphor icons, while preserving legacy caller-provided icons through a generic sidebar icon type.
- Converted `MobileSidebarNavigation` from a raw `<button>` row to `NotionButton variant="nav"` so the mobile nav row follows the shared primitive path.
- Added `migrationFoundation.source.test.ts` to block hard-coded component colors, `md:` tablet shrink, scale/spring press motion, local shell palettes, and split button contracts in the targeted migrated files.

## Verification

| Command | Result | Notes |
|---------|--------|-------|
| `npm run test -- src/components/ui/__tests__/migrationFoundation.source.test.ts` | Passed | First run failed as expected before implementation; final run passed 5/5 tests. |
| `npx eslint ...targeted Phase 7 files...` | Passed | Fixed the empty `InputProps` interface and the raw mobile nav button warning. |
| `git diff --check` | Passed | No whitespace/conflict-marker issues. |
| `npm run build` | Passed | Build completed. Existing Rollup chunk warnings and CSS minify warnings remain unrelated to this phase. |
| `npx vite --host 127.0.0.1 --port 1422` | Started during verification | The app is reachable at `http://127.0.0.1:1422/` when the dev server session is running. |
| Playwright browser smoke across `390x844`, `768x1024`, `834x1194`, `1024x768`, `1280x800` | Blocked by runtime | Plain browser reaches `Loading...` because the parent app expects Tauri `invoke`/`listen` APIs and database initialization. Screenshots were saved under `/tmp/deep-student-phase7-*.png`. |

## Deviations

- `gsd-sdk` is unavailable in the shell, so planning and execution artifacts were created through the documented manual fallback path.
- `npm run build` regenerated `src-tauri/tauri.conf.json` Android `versionCode`; that generated side effect was restored because it is unrelated to Phase 7 UI migration.
- Full manual Tauri visual UAT is still pending for root chat shell, settings sheet/drawer, and desktop chrome because the browser-only Vite runtime stalls at the app loading screen without Tauri APIs.

## Self-Check

PASSED for automated Phase 7 foundation gates:

- Token bridge parity is covered by source tests.
- `NotionButton` and `ui/shad/Button` share one contract.
- Targeted primitives and mobile shell controls keep touch density until `lg`.
- Targeted migrated files reject hard-coded component colors, local RGBA/shadow palettes, `md:` shrink, and scale/spring motion.
- Targeted shell/internal icons moved to Phosphor imports.

Manual runtime visual verification remains a follow-up item for a real Tauri dev/runtime session.
