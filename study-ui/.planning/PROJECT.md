# study-ui Mobile Adaptation

## What This Is

`study-ui` is a React 19 + Vite 7 + Tailwind CSS v4 + Tauri 2 interface for a study assistant workspace. The current work focuses on adapting the existing `App -> AppChrome -> Sidebar + Main` UI shell to phone, tablet, and desktop without creating separate mobile pages or a second design system.

This is a brownfield UI migration. The product already has a desktop-first shell, a reusable sidebar, a thread canvas, a settings panel, theme tokens, and desktop window behavior; the project goal is to unify responsive behavior and make the same components reliable on mobile and tablet.

## Core Value

One shared UI architecture must feel usable on phone, tablet, and desktop while preserving the existing desktop Tauri shell behavior.

## Requirements

### Validated

- Existing React/Vite/Tauri app shell is in place - existing
- `App -> AppChrome -> Sidebar + Main` is the active composition chain - existing
- Sidebar, thread canvas, settings panel, Radix/shadcn primitives, Phosphor icons, and theme tokens already exist - existing
- `src/styles/app.css` already contains theme, shell, safe-area, sidebar, button, workspace, and composer tokens - existing
- Existing design guidance requires mobile-first layout, 44px touch targets, safe-area handling, semantic color tokens, restrained animation, and no additional component libraries - existing

### Active

- [ ] Introduce a unified responsive environment and layout policy for `phone < 640`, `tablet 640-1023`, and `desktop >= 1024`, with behavior initially split into `compact < 1024` and `desktop >= 1024`.
- [ ] Add root datasets such as `data-form-factor`, `data-sidebar-mode`, `data-density`, and related layout state so CSS tokens can react to policy rather than component-local breakpoints.
- [ ] Split sidebar state semantics so mobile drawer state and desktop collapsed/docked state no longer share the same overloaded boolean.
- [ ] Keep phone and tablet portrait navigation as a Sheet/Drawer first; keep desktop as docked sidebar; allow tablet landscape to evolve into a rail later without blocking the initial compact policy.
- [ ] Convert `ThreadCanvas` to consume workspace/composer/safe-area tokens instead of hard-coded `px-4 md:px-8`, `max-w-[44rem]`, and desktop composer assumptions.
- [ ] Keep `SettingsPanel` as one page, but make dense regions degrade to mobile-safe cards, definition lists, full-width controls, and touch-friendly rows.
- [ ] Preserve Windows/macOS desktop titlebar, drag region, window controls, resize handles, translucent/opaque backgrounds, and minimum desktop window behavior.
- [ ] Add source/unit tests that lock breakpoint boundaries, layout policy outputs, root datasets, safe-area token use, and mobile/tablet/desktop shell semantics.

### Out of Scope

- Building separate `Mobile*`, `Tablet*`, and `Desktop*` copies of the app shell - this would multiply maintenance cost and conflicts with the chosen unified architecture.
- Replacing the current design system or adding a new component library - existing Radix/shadcn primitives and CSS variables are sufficient.
- Visual redesign for its own sake - this milestone is about responsive structure, density, safe areas, and touch usability.
- Reworking the core study product model, data layer, model service integration, or Tauri backend - this phase only touches the UI adaptation layer.
- Complex animation, spring/bounce interactions, or route-level motion - existing guidelines require restrained transitions under 300ms and reduced-motion support.

## Context

The current codebase is desktop-first with partial compact behavior. `src/components/shell/AppChrome.tsx` still uses `matchMedia("(max-width: 767px)")`, which leaves tablet behavior ambiguous and keeps responsive policy inside the shell component. `src/App.tsx` uses `isSidebarOpen` for multiple meanings: mobile drawer visibility, desktop sidebar visibility, and settings-mode forced expansion.

`src/components/content/ThreadCanvas.tsx` uses desktop-oriented spacing and max-width classes, and its composer has not been fully wired to safe-area and mobile keyboard constraints. `src/components/content/SettingsPanel.tsx` is a large single-page settings surface with dense grids, pseudo-table rows, tabs, switches, dialog sizing, and long content that need responsive degradation rather than a duplicated mobile page.

The repository already contains strong prior planning material in:

- `docs/plans/2026-03-19-win-tablet-mobile-ui-adaptation-executable-todo.md`
- `docs/plans/2026-03-17-mobile-tablet-adaptation-executable-todo.md`
- `UI优化方案.md`
- `AGENTS.md`

These documents align with the current recommendation: one component set, three form factors, compact vs desktop interaction behavior, token-driven layout, and a strict ban on new component libraries or CSS-in-JS.

## Constraints

- **Tech stack**: React 19, Vite 7, TypeScript 5.9+, Tailwind CSS v4, Radix UI, shadcn/ui, Phosphor Icons, and Tauri 2 are locked.
- **Design system**: Use semantic CSS variables from `src/styles/app.css`; do not hard-code colors or introduce CSS-in-JS.
- **Responsive strategy**: Default CSS should be mobile-first and progressively enhance toward tablet and desktop.
- **Touch target**: Mobile and tablet primary interactive targets must be at least 44px by 44px.
- **Desktop compatibility**: Mobile adaptation must not regress Tauri desktop titlebars, drag regions, window controls, resize handles, or minimum desktop window behavior.
- **Architecture**: Preserve one shared `Sidebar`, `Titlebar`, `ThreadCanvas`, and `SettingsPanel`; avoid three parallel shells.
- **Verification**: Automated checks should cover breakpoint/policy logic and source-level structural contracts; real-device or viewport manual checks remain required for keyboard/safe-area behavior.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Use one shared responsive UI instead of separate mobile UI | Reduces maintenance cost and matches current component architecture | - Pending |
| Use `phone < 640`, `tablet 640-1023`, `desktop >= 1024` | Aligns with Tailwind defaults and user-provided research | - Pending |
| Use `compact < 1024` and `desktop >= 1024` for initial interaction behavior | Avoids over-splitting interaction states while still fixing tablets | - Pending |
| Drive layout through root datasets and CSS tokens | Prevents breakpoint logic from spreading through components | - Pending |
| Split mobile drawer state from desktop collapsed state | Fixes overloaded sidebar state semantics in `App.tsx` | - Pending |
| Keep SettingsPanel as a single page with responsive degradation | Avoids duplicating settings logic while solving mobile density problems | - Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition**:
1. Requirements invalidated? Move to Out of Scope with reason.
2. Requirements validated? Move to Validated with phase reference.
3. New requirements emerged? Add to Active.
4. Decisions to log? Add to Key Decisions.
5. "What This Is" still accurate? Update if drifted.

**After each milestone**:
1. Full review of all sections.
2. Core Value check: still the right priority?
3. Audit Out of Scope: reasons still valid?
4. Update Context with current state.

---
*Last updated: 2026-04-23 after initialization*
