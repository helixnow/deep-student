---
phase: 06-mobile-home-polish
plan: 01
subsystem: ui
tags: [mobile, thread-canvas, empty-state, composer, polish]

requires:
  - phase: 05-touch-targets-and-verification
    provides: verified compact touch targets and phone/tablet/desktop responsive policy
provides:
  - Phone-only ChatGPT-mobile-style landing for `ThreadCanvas` empty state.
  - Phone-only floating pill composer with add/input/send controls and no recording affordance.
  - Phone top-left chrome with an edge-aligned hamburger menu and no title/update clutter.
  - Tablet/desktop ThreadCanvas empty state and composer remain on the previously verified path.
  - Source coverage prevents upgrade/user-plus entry points and protects phone-only gating.
affects: [mobile-home, thread-canvas, phase-6-uat]

tech-stack:
  added: []
  patterns:
    - Phone polish is gated with `sm:hidden`.
    - Tablet/desktop continuity is gated with `sm:flex` and `sm:block`.
    - Visual prompt cards are CSS/Tailwind surfaces, not external assets.

key-files:
  modified:
    - src/components/content/ThreadCanvas.tsx
    - src/components/content/ThreadCanvas.source.test.ts
    - src/components/shell/AppChrome.tsx
    - src/components/shell/AppChrome.source.test.ts
    - .planning/REQUIREMENTS.md
    - .planning/ROADMAP.md
    - .planning/STATE.md
  created:
    - .planning/phases/06-mobile-home-polish/06-UAT.md

requirements-completed: [HOME-01, HOME-02, HOME-03, HOME-04, HOME-05]

completed: 2026-04-23
---

# Phase 6: Mobile Home Polish Summary

**Phone empty state now uses a mobile landing treatment while tablet and desktop keep the verified Phase 5 layout.**

## Accomplishments

- Added a phone-only `thread-mobile-empty-state` with a full-bleed horizontal prompt-card strip, centered title/description, and a single suggestion CTA.
- Added a phone-only `thread-phone-composer` that reads as a floating single-line pill with 44px add, input, and send targets.
- Removed the phone composer recording icon so the mobile input stays quieter and focused on text.
- Polished phone top-left chrome so it starts at the mobile edge, uses a hamburger menu affordance, and removes the compact title/update-badge collision.
- Preserved the existing tablet/desktop empty state and composer behind `sm:flex`/`sm:block` so Phase 5 desktop/tablet verification is not disturbed.
- Kept the user's requested exclusion: no upgrade, user-plus, account-growth, or new product entry points were added.
- Updated `ThreadCanvas.source.test.ts` to lock phone-only vs tablet/desktop behavior.

## Verification

- `node --test --experimental-strip-types src/components/content/ThreadCanvas.source.test.ts` - passed, 10 tests.
- `node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Titlebar.source.test.ts` - passed, 24 tests.
- `rg --files src | rg '(\\.source\\.test|\\.test)\\.tsx?$' | xargs node --test --experimental-strip-types` - passed, 226 tests.
- `npm run lint` - passed.
- `npm run build` - passed, Vite built 4700 modules.
- Playwright viewport smoke passed for `390x844`, `768x1024`, and `1280x800`; screenshots are recorded in `06-UAT.md`, including the top-left phone chrome follow-up.

## Notes

- The design uses CSS/Tailwind prompt cards instead of image assets so the mobile landing stays lightweight and deterministic.

## Next Step

Run `$gsd-ui-review 6` for a final visual audit if desired, then `$gsd-complete-milestone` when ready.
