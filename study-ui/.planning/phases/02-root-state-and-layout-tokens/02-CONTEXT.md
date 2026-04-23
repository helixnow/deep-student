# Phase 2: Root State And Layout Tokens - Context

**Gathered:** 2026-04-23
**Status:** Ready for execution fallback planning

<domain>
## Phase Boundary

Phase 2 makes Phase 1's responsive policy observable to the shell root and consumable by CSS. It should split `App.tsx` sidebar state into mobile drawer visibility and desktop collapsed state, expose stable root datasets from `AppChrome`, and define shared layout token names in `src/styles/app.css`.

This phase does not redesign the sidebar, implement compact navigation auto-close, introduce tablet rail mode, or migrate `ThreadCanvas` and `SettingsPanel` to consume all tokens. Those remain Phase 3 and Phase 4 work.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** Keep Phase 1 policy modules as the source of `formFactor`, `isCompact`, `sidebarMode`, `density`, and `shellMode`.
- **D-02:** Split `App.tsx` state into `mobileSidebarOpen` and `sidebarCollapsed`; `AppChrome` decides which state is active based on `layoutPolicy.sidebarMode`.
- **D-03:** Preserve existing visible behavior: compact uses the existing `Sheet`; desktop uses docked sidebar; settings mode still keeps desktop sidebar visible.
- **D-04:** Add stable shell root datasets: `data-form-factor`, `data-sidebar-mode`, `data-density`, `data-shell-mode`, `data-compact`, and sidebar visibility/collapsed hints.
- **D-05:** Define reusable token names once, then override the same names by datasets. Do not create separate mobile-only or tablet-only token families.
</decisions>

<canonical_refs>
## Canonical References

- `.planning/ROADMAP.md` - Phase 2 goal and success criteria.
- `.planning/REQUIREMENTS.md` - `SHELL-01`, `SHELL-02`, `TOKN-01`, `TOKN-02`.
- `.planning/phases/01-responsive-policy-foundation/01-01-SUMMARY.md` - Phase 1 policy outputs and integration notes.
- `src/App.tsx` - Current overloaded sidebar state owner.
- `src/components/shell/AppChrome.tsx` - Shell root and policy consumer.
- `src/components/shell/AppChrome.source.test.ts` - Shell source contract tests.
- `src/styles/app.css` - Existing theme, shell, safe-area, and layout token layer.
- `src/styles/app.source.test.ts` - Existing style source contract tests.
</canonical_refs>

<code_context>
## Existing Code Insights

- `App.tsx` currently stores `isSidebarOpen`, which still mixes mobile drawer, desktop docked visibility, and settings-mode forced expansion semantics.
- `AppChrome.tsx` already computes `responsiveEnvironment` and `layoutPolicy`, so it is the right root place to expose policy datasets without duplicating policy in `App.tsx`.
- `app.css` already has safe-area tokens and several layout-related tokens, but it needs clearer aliases for gutters, safe-area-aware viewport height, sidebar width/mode, composer offsets, and touch target size.
- Source tests are the right lightweight enforcement mechanism for this phase because visible UI behavior should not materially change yet.
</code_context>

<deferred>
## Deferred Ideas

- Compact sidebar auto-close after navigation remains Phase 3.
- Tablet rail remains later-phase work.
- ThreadCanvas and SettingsPanel token consumption remains Phase 4.
- Global 44px enforcement across every control remains Phase 5.
</deferred>

---
*Phase: 02-root-state-and-layout-tokens*
*Context gathered: 2026-04-23*
