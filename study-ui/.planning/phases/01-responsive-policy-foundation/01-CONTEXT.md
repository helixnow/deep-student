# Phase 1: Responsive Policy Foundation - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 delivers the responsive decision foundation only: a tested environment model and a tested app layout policy that downstream shell/content work can consume. It should define how the app classifies `phone`, `tablet`, `desktop`, `isCompact`, sidebar mode, and density, and it should remove `AppChrome`'s local `matchMedia("(max-width: 767px)")` policy ownership.

This phase does not redesign `AppChrome`, split sidebar state in `App.tsx`, rewrite `ThreadCanvas`, or adapt `SettingsPanel`; those belong to later roadmap phases. Phase 1 may touch `AppChrome` only enough to consume the new policy hook/module and prove the old compact breakpoint no longer lives there.

</domain>

<decisions>
## Implementation Decisions

### Breakpoint Model
- **D-01:** Use exactly three form factors: `phone` for widths below `640`, `tablet` for `640-1023`, and `desktop` for `1024` and above.
- **D-02:** Use `isCompact = width < 1024` as the initial interaction split. Phone and tablet both count as compact for Phase 1; desktop starts at `1024`.
- **D-03:** Tests must cover the boundary widths `639`, `640`, `767`, `768`, `1023`, and `1024`, because the existing code used `767` and the new model must prove that tablet is no longer accidentally mixed into desktop/mobile behavior.

### Module Boundaries
- **D-04:** Create a dedicated responsive environment module, recommended path `src/lib/responsive-env.ts`, that owns viewport/input facts and exports pure helpers for classification.
- **D-05:** Create a separate layout policy module, recommended path `src/lib/app-layout-policy.ts`, that maps environment facts into app decisions such as `formFactor`, `isCompact`, `sidebarMode`, `density`, and layout hints.
- **D-06:** Keep `src/lib/app-shell.ts` focused on desktop shell geometry, surface classes, platform titlebar behavior, and Tauri window chrome helpers. Do not turn `app-shell.ts` into the new responsive policy module.
- **D-07:** Keep breakpoint constants in one TypeScript source of truth. CSS can react to root datasets/tokens in later phases, but components should not introduce new `window.matchMedia` calls or duplicate breakpoint numbers.

### Policy Shape
- **D-08:** The Phase 1 policy should return a minimal, stable shape that later phases can extend without churn: `formFactor`, `isCompact`, `sidebarMode`, `density`, and optional `contentMaxWidth`/`pageGutter` hints if those can be expressed without coupling to Phase 2 token work.
- **D-09:** Use string unions for policy outputs rather than booleans where future states are expected. For example, prefer `sidebarMode: "drawer" | "docked"` now, with room for `"rail"` later, instead of `isSidebarDocked`.
- **D-10:** Tablet landscape rail behavior is not implemented in Phase 1. The policy may leave an extension seam, but the first compact behavior remains drawer-oriented until Phase 3.

### AppChrome Consumption
- **D-11:** `AppChrome` should consume the new responsive policy instead of directly owning `compactViewportQuery` and `getCompactViewport`.
- **D-12:** The implementation should preserve the existing SSR-safe `useSyncExternalStore` pattern or an equivalent testable hook shape so server/default snapshots do not crash when `window` is unavailable.
- **D-13:** Phase 1 should not change visible desktop shell behavior beyond replacing the compact decision source. Existing titlebar, traffic-light accessory, docked sidebar, seam, and window control behavior should remain functionally unchanged.

### Test Strategy
- **D-14:** Add direct unit tests for the responsive environment classifier and app layout policy.
- **D-15:** Update or add source tests for `AppChrome` to assert it consumes the policy module and no longer contains `matchMedia("(max-width: 767px)")`.
- **D-16:** Existing `src/lib/app-shell.test.ts` should keep passing; any app-shell changes should be additive or cleanup-only.

### the agent's Discretion
- The exact function names and hook names are left to the planner/implementer, as long as the module boundaries and output semantics above are preserved.
- The exact representation of density can be chosen during planning, but it must distinguish at least compact touch-oriented density from desktop density.
- The policy may include extra fields only if they support Phase 2/3 without making Phase 1 broad or speculative.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### GSD Scope
- `.planning/PROJECT.md` - Core value, constraints, and out-of-scope boundaries for the responsive migration.
- `.planning/REQUIREMENTS.md` - v1 requirements, especially `RESP-01` through `RESP-04`.
- `.planning/ROADMAP.md` - Phase 1 goal, dependencies, success criteria, and later-phase boundaries.
- `.planning/STATE.md` - Current workflow state and known risk that `gsd-sdk` is unavailable.

### Prior Responsive Research
- `docs/plans/2026-03-19-win-tablet-mobile-ui-adaptation-executable-todo.md` - Strong prior plan for responsive environment and layout policy architecture.
- `docs/plans/2026-03-17-mobile-tablet-adaptation-executable-todo.md` - Earlier mobile/tablet adaptation checklist and breakpoint rationale.
- `UI优化方案.md` - Accessibility, responsive design, touch target, and quality concerns to keep in mind.
- `AGENTS.md` - Locked stack, design rules, mobile-first guidance, forbidden dependencies, and project conventions.

### Current Code Contracts
- `src/lib/app-shell.ts` - Current desktop shell geometry and surface helper responsibilities.
- `src/lib/app-shell.test.ts` - Existing shell geometry tests that should keep passing.
- `src/components/shell/AppChrome.tsx` - Current compact viewport logic and shell composition entry point.
- `src/components/shell/AppChrome.source.test.ts` - Existing source-level shell behavior assertions that may need targeted updates.
- `src/components/ui/sheet.tsx` - Existing drawer primitive that later compact shell phases will continue to use.
- `src-tauri/tauri.conf.json` - Desktop minimum window baseline (`minWidth: 980`, `minHeight: 680`) that mobile/tablet work must not regress.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/app-shell.ts`: Provides `DesktopPlatform`, `TitlebarMode`, window chrome helpers, titlebar spacing, surface classes, and `APP_LAYOUT_TOKENS`; keep it as desktop shell geometry rather than mixing viewport policy into it.
- `src/components/shell/AppChrome.tsx`: Main integration point for policy consumption. It currently owns `compactViewportQuery`, `subscribeCompactViewport`, and `getCompactViewport`; these should move behind the responsive environment/policy layer.
- `src/components/ui/sheet.tsx`: Existing Radix Dialog-based Sheet supports compact sidebar presentation; Phase 1 should not replace it.
- `src/components/shell/Titlebar.tsx`, `Sidebar.tsx`, `WindowControls.tsx`, `FramelessResizeHandles.tsx`: Later shell phases should consume policy indirectly, but Phase 1 should avoid visible behavior churn in these components.

### Established Patterns
- Tests use Node's built-in `node:test` with `--experimental-strip-types` for TypeScript files.
- Source tests inspect exact source patterns for shell contracts, so refactors should update assertions deliberately rather than leaving stale expectations.
- The project favors semantic CSS variables and Tailwind classes, with no CSS-in-JS or new component libraries.
- Existing UI guidance favors restrained transitions and explicitly avoids scale/spring-style animation.

### Integration Points
- `src/App.tsx` remains the owner of app mode and sidebar state, but Phase 1 should not perform the full state split; it only prepares the policy needed by Phase 2.
- `src/components/shell/AppChrome.tsx` is the first consumer of responsive policy.
- `src/styles/app.css` will consume root datasets/tokens in Phase 2, so Phase 1 should not overfit CSS variable names before that token work is planned.

</code_context>

<specifics>
## Specific Ideas

- User-provided direction is locked: do not build a separate mobile UI; adapt the existing `App -> AppChrome -> Sidebar + Main` skeleton.
- User-provided breakpoints are locked: `phone < 640`, `tablet 640-1023`, `desktop >= 1024`.
- User-provided behavior split is locked for now: `compact < 1024` and `desktop >= 1024`.
- Root datasets and CSS token consumption are important, but they are Phase 2 outputs; Phase 1 should design the policy shape with those future consumers in mind.

</specifics>

<deferred>
## Deferred Ideas

- Tablet landscape rail mode is deferred to Phase 3 or later. Phase 1 may leave an enum seam but should not implement rail behavior.
- Mobile keyboard/composer safe-area handling is deferred to Phase 4.
- SettingsPanel dense table/card degradation is deferred to Phase 4.
- Global touch target normalization is deferred to Phase 5.

</deferred>

---

*Phase: 01-responsive-policy-foundation*
*Context gathered: 2026-04-23*
