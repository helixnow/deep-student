# Phase 5 Discussion Log

**Command:** `$gsd-discuss-phase 5`
**Date:** 2026-04-23
**Mode:** Manual fallback, assumptions-first

## Why Manual Fallback Was Used

`gsd-sdk` is not available in the current shell `PATH`, and the current collaboration mode does not expose the interactive `request_user_input` workflow. To keep momentum, this discussion used the Phase 5 roadmap, requirements, existing Phase 1-4 artifacts, and direct code/test inspection to select safe defaults.

## Gray Areas Resolved

| Gray Area | Decision |
|-----------|----------|
| Touch target source of truth | Use existing density/form-factor tokens, especially `--touch-target-size`, rather than adding a separate mobile UI or new token family. |
| Desktop sizing | Preserve compact desktop controls where possible; do not globally force desktop controls to 44px. |
| Switch policy | Treat switch as an explicit Phase 5 target because its visual track is smaller than 44px, even when settings rows provide larger touch rows. |
| Button variants | Audit `sm` and `icon` variants because default buttons are already mobile-first but smaller variants can leak into compact surfaces. |
| Test cleanup | Fix stale Phase 4 source tests as part of verification hardening. |
| Manual acceptance | Commit a manual viewport checklist instead of implying visual acceptance from automated tests. |
| New testing tools | Do not add new E2E/visual dependencies unless planning discovers existing infrastructure. |

## Evidence Collected

| Evidence | Notes |
|----------|-------|
| `src/styles/app.css` | Existing responsive tokens include `--control-height-touch` and `--touch-target-size`. |
| `src/components/ui/button.tsx` | Default button is compact-safe on phone/tablet, but `sm` and `icon` variants need review. |
| `src/components/shell/ShellButton.tsx` | Shell nav button compact target is already 44px; shell icon variant needs review. |
| `src/components/ui/input.tsx` | Input already uses mobile-first 44px height and compact desktop override. |
| `src/components/ui/textarea.tsx` | Textarea is tall enough, but lacks a source contract test. |
| `src/components/ui/switch.tsx` | Current switch visual height is 32px; Phase 5 must decide hit-area approach. |
| `src/components/content/ThreadCanvas.tsx` | Composer send button is 44px; secondary controls depend on shared button variant behavior. |
| `src/components/content/SettingsPanel.tsx` | Phase 4 created touch-safe preference/action rows and responsive tabs. |

## Test Probe

Targeted source/unit probe showed most current tests pass, but two stale expectations remain:

- `src/components/content/SettingsPanel.test.ts` still expects the old language tab class before Phase 4 responsive tab changes.
- `src/components/shell/ShellButton.source.test.ts` still expects the old nav button class composition before shell button source cleanup.

These should be repaired in Phase 5 before claiming verification complete.

## Recommended Acceptance Shape

- Automated: `npm run lint`, `npm run build`, and a targeted source/unit suite covering responsive policy, app shell, shell components, content surfaces, settings helpers, and shared controls.
- Manual: documented checklist for `390x844`, `768x1024`, `834x1194`, `1024x768`, and `1280x800`.
- Desktop-specific manual coverage: titlebar drag, window controls, resize handles, sidebar dock/collapse behavior, and minimum desktop layout.

## Next Step

Run `$gsd-ui-phase 5`, then `$gsd-plan-phase 5`.
