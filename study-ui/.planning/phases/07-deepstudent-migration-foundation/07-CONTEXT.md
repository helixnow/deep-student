---
phase: 07-deepstudent-migration-foundation
status: captured
created: 2026-04-24
source:
  - User request: migrate study-ui into deepstudent.
  - Phase 6 UI review: study-ui is strong, parent app primitive/token migration is incomplete.
---

# Phase 7 Context: DeepStudent Migration Foundation

## Goal

Move the study-ui design system contract into the parent DeepStudent app in a controlled foundation phase.

This phase should prepare the parent app for incremental surface migration. It should not rewrite every page or create a separate mobile-only design system.

## Decisions

- `study-ui` is the source of truth for design direction, responsive policy, shell behavior, touch density, semantic color usage, typography restraint, and primitive behavior.
- The parent app is the implementation target. The work must happen under the existing parent app `src/` structure, not by keeping `study-ui` as a separate product shell forever.
- Migration must be incremental. First unify tokens and primitives, then migrate product surfaces one by one.
- Preserve desktop Tauri behavior. macOS/Windows titlebar, drag regions, window controls, resize handles, and existing desktop density must not regress.
- Phone and tablet remain touch density. Controls must not compact below 44px before `lg` / `>=1024px`.
- Use semantic CSS variables and Tailwind token classes. Component-level hard-coded colors are not allowed except inside token definition files.
- No new UI library, CSS-in-JS system, or broad dependency replacement should be introduced for this phase.
- Legacy icons can remain in untouched surfaces, but newly migrated shell and primitive work should follow the study-ui icon direction and document the transition path.

## Agent Discretion

- Decide whether parent `NotionButton` should wrap the study-ui button contract or be replaced by a shared primitive facade.
- Decide how to structure static checks: source tests, grep-based scripts, ESLint rule extensions, or focused unit tests.
- Decide the safest first root surfaces for verification, with likely focus on chat shell, mobile header/sidebar, settings sheet/drawer, and desktop shell preservation.
- Decide which hard-coded values belong in token files and which should be removed from component class strings.

## Deferred Ideas

- Full redesign of all DeepStudent pages.
- Replacing every Lucide icon in one pass.
- Rebuilding settings, chat, notes, learning hub, and task dashboard all in the same phase.
- Adding a second mobile shell or separate mobile-only component tree.
- Introducing a new UI/component library beyond existing Radix/shadcn-style primitives.

## Evidence From Phase 6 UI Review

- `study-ui` has a healthy component foundation: `Button`, `ShellButton`, settings row/section/block helpers, and responsive shell state.
- Parent app has token bridge files in `src/styles/shadcn-variables.css` and `src/styles/theme-colors.css`.
- Parent app primitive convergence is incomplete: `NotionButton`, `ui/shad/Button`, and raw `button` usage still coexist.
- Parent app touch safety is incomplete: some buttons and switches still use 32px-40px sizing or tablet-shrinking classes.
- Parent app color tokenization is incomplete: hard-coded component palettes, local RGBA shadows, and non-token focus rings still appear in migrated-adjacent surfaces.
