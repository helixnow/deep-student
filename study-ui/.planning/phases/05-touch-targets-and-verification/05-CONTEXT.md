# Phase 5: Touch Targets And Verification - Context

**Gathered:** 2026-04-23
**Status:** Ready for UI contract and planning
**Source:** `$gsd-discuss-phase 5` manual fallback

## Phase Boundary

Phase 5 finalizes the responsive migration by locking control hit targets and verification coverage. It should not redesign content surfaces, introduce a second mobile UI, or change product behavior that was already adapted in Phases 1-4.

## In Scope

- Audit and adjust shared controls so phone/tablet hit targets meet the 44px expectation.
- Preserve compact desktop control sizing where existing desktop density depends on it.
- Cover `Button`, `ShellButton`, `Input`, `Textarea`, `Switch`, composer actions, settings rows, and shell icon controls.
- Repair stale tests discovered after Phase 4 changes.
- Run hard verification gates: lint, build, targeted source/unit tests.
- Create manual viewport acceptance coverage for `390x844`, `768x1024`, `834x1194`, `1024x768`, and `1280x800`.

## Out Of Scope

- A separate mobile UI implementation.
- New Playwright/Cypress or visual regression dependencies unless an existing project setup is discovered during planning.
- Tablet landscape rail navigation or a new sidebar mode.
- Real-device keyboard behavior fixes unless a concrete regression is found during Phase 5 validation.
- Desktop visual redesign beyond preserving compact sizing and shell behavior.

## Decisions

### Touch Target Policy

- Use the existing `--touch-target-size` and root `data-density="touch"` state as the canonical source of compact touch sizing.
- Phone/tablet controls must expose at least a 44px interaction target.
- Desktop controls may remain compact where the current UI intentionally uses smaller button or switch chrome.
- Avoid adding parallel `mobile-*` or `tablet-*` token families; prefer density/form-factor token overrides.

### Primitive Boundaries

- Prefer shared primitive/token fixes over page-local overrides when a control is used in multiple surfaces.
- Keep `Button` and `ShellButton` aligned so shell icons, composer buttons, and shared actions do not drift.
- `Input` already uses mobile-first `h-11` behavior and should be protected by tests.
- `Textarea` already exceeds the 44px minimum, but needs source-test coverage so future edits do not shrink compact targets.
- `Switch` needs explicit Phase 5 attention because the primitive visual track is smaller than 44px, even though settings rows now provide larger touch rows.

### Verification Strategy

- Treat `npm run lint` and `npm run build` as hard gates.
- Targeted tests must include responsive policy, app shell policy, shell components, thread canvas, settings panel, and shared control source contracts.
- Stale tests discovered during discussion are part of Phase 5 hardening, not separate cleanup.
- Manual viewport acceptance should be documented in a committed artifact instead of implied from command output.
- Desktop manual checks must explicitly cover titlebar drag regions, macOS/Windows window controls, resize handles, and minimum desktop width behavior.

## Current Code Signals

| Area | Finding | Phase 5 Consequence |
|------|---------|---------------------|
| `src/styles/app.css` | `--touch-target-size` already switches to `2.75rem` for phone/tablet density. | Reuse this token instead of inventing new responsive sizing primitives. |
| `src/components/ui/button.tsx` | Default buttons are `h-11` mobile-first, but `sm` and `icon` variants still rely on compact button tokens. | Audit `sm`/`icon` hit targets for phone/tablet and preserve compact desktop sizing. |
| `src/components/shell/ShellButton.tsx` | Nav buttons are already `min-h-[2.75rem]` on compact, while icon buttons inherit the compact icon size. | Make shell icon controls touch-safe in compact mode without bloating desktop chrome. |
| `src/components/ui/input.tsx` | Input uses `h-11` then `md:h-10`. | Keep as the expected mobile-first pattern and retain source coverage. |
| `src/components/ui/textarea.tsx` | Textarea uses a large `min-h-28`. | Add source contract coverage rather than changing sizing unless planning finds a gap. |
| `src/components/ui/switch.tsx` | Switch track is `h-8`, below 44px by visual box size. | Decide whether to enlarge hit target around the switch, adjust density behavior, or document row-level target coverage. |
| `src/components/content/ThreadCanvas.tsx` | Composer send button is already `h-11 w-11`; secondary `Button size="sm"` controls depend on shared button sizing. | Shared button fix can protect composer secondary actions. |
| `src/components/content/SettingsPanel.tsx` | Phase 4 rows use `min-h-[var(--touch-target-size)]`. | Preserve settings row touch behavior while testing the shared switch/control contracts. |

## Test Signals

- `src/components/ui/button.source.test.ts` already covers default mobile-first button height, but not all compact-sensitive variants.
- `src/components/ui/input.source.test.ts` already covers mobile and desktop input heights.
- `src/components/ui/switch.source.test.ts` covers the current switch visual sizing but not 44px touch-target policy.
- No `src/components/ui/textarea.source.test.ts` exists yet.
- `src/components/shell/ShellButton.source.test.ts` contains stale expectations after the Phase 4 shell button class split.
- `src/components/content/SettingsPanel.test.ts` contains stale expectations for the responsive language tab class after Phase 4.

## Assumptions

- Manual fallback is acceptable because `gsd-sdk` is not available in the shell `PATH`.
- The next workflow step should produce a focused UI contract for control density and acceptance states before implementation planning.
- Source tests are the right lightweight guardrail for this repo's current UI class/token contracts.

## Next Step

Run `$gsd-ui-phase 5` to lock the Phase 5 UI design contract, then `$gsd-plan-phase 5` for executable implementation planning.
