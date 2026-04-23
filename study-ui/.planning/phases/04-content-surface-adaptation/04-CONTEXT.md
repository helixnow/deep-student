# Phase 4: Content Surface Adaptation - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 4 adapts the main content surfaces after the responsive policy, shell datasets, layout tokens, and compact sidebar behavior are already in place. It makes `ThreadCanvas` and `SettingsPanel` readable, touch-friendly, and safe-area-aware across phone, tablet, and desktop.

In scope:

- `ThreadCanvas` consumes shared layout tokens for content width, gutters, composer width, composer placement, and safe-area spacing.
- The thread composer prioritizes text input and send action on compact screens while keeping secondary actions usable without desktop clutter.
- `SettingsPanel` stays one shared page and degrades dense regions into mobile-safe cards, definition lists, full-width controls, and touch-friendly switch rows.
- Settings tabs and dense controls become small-screen safe without introducing a separate mobile settings page.
- Source tests lock token consumption, small-screen degradation, and prevention of desktop-only hard-coded widths.

Out of scope:

- Separate mobile or tablet versions of `ThreadCanvas` or `SettingsPanel`.
- Tablet rail/navigation changes; Phase 3 intentionally keeps compact navigation drawer-first.
- Global control sizing audit for every primitive; that remains Phase 5.
- Product/data-model changes to chat, settings, model services, memory, or privacy features.

</domain>

<decisions>
## Implementation Decisions

### Thread Canvas Layout

- **D-01:** Replace ThreadCanvas page-local width and padding constants with existing layout tokens: `--workspace-max-width`, `--composer-max-width`, `--page-gutter-inline`, `--page-gutter-block`, and `--layout-safe-area-*`.
- **D-02:** Remove `max-w-[44rem]` and desktop-first `px-4 md:px-8` from `ThreadCanvas`; width and gutters should come from tokens already overridden by root datasets.
- **D-03:** Keep the current single-column document-style thread surface. Do not introduce a feed/grid/timeline layout in this phase.
- **D-04:** On compact screens, the empty state should be slightly less vertically centered and should leave clear space for the bottom composer. Do not add dashboard cards or extra suggestions.

### Composer Behavior

- **D-05:** Composer remains one shared component area inside `ThreadCanvas`; do not fork a mobile composer component.
- **D-06:** Compact composer prioritizes text input plus a persistent send button. Secondary actions such as attachment, model, and reasoning-strength controls may wrap, move to a secondary row, or become horizontally scrollable, but they should not compete with the input/send path.
- **D-07:** Composer footer must consume safe-area tokens for bottom/left/right spacing. Use `--composer-max-width` and `--composer-bottom-offset` rather than local width/bottom constants.
- **D-08:** Do not claim full mobile keyboard handling is solved by source tests. Phase 4 should make composer spacing safe-area-aware and keep the scroll area usable; real WebView keyboard validation remains Phase 5/manual verification.

### Settings Layout

- **D-09:** `SettingsPanel` remains a single shared page. The implementation should modify shared building blocks such as `SettingsSection`, `SettingBlock`, `SettingsRow`, and small helper components instead of creating mobile-specific settings pages.
- **D-10:** Settings content width and page gutters should follow layout tokens, not `max-w-[46rem]` or desktop-only scroll padding. A minimal `AppChrome` settings scroll wrapper edit is allowed only if needed to satisfy `SETT-05`; do not change sidebar/titlebar behavior.
- **D-11:** Dense grids may keep desktop multi-column layouts at larger breakpoints, but phone and compact tablet should default to single-column readable groups.

### Dense Regions

- **D-12:** The embedding-dimensions pseudo-table should degrade below desktop into cards or definition-list rows. Avoid making horizontal overflow the primary mobile solution.
- **D-13:** Desktop may keep the existing six-column pseudo-table rhythm for density, but compact screens must have labels next to values so each row is understandable without column headers.
- **D-14:** Preview dialogs in SettingsPanel should keep one shared dialog implementation but use viewport-safe widths and responsive padding instead of fixed desktop-feeling widths.

### Tabs And Switches

- **D-15:** Short tab sets with 2-3 choices, such as language and theme, should be full-width/equal-width on compact screens and can return to intrinsic width on desktop.
- **D-16:** Larger or variable tab sets, if encountered, should use horizontal scrolling with stable touch targets rather than compressed tiny triggers.
- **D-17:** Switch settings should become row-level touch targets. Prefer a reusable SettingsPanel-level switch row/helper that preserves accessible labels and keeps the visible switch on the right on larger screens.
- **D-18:** Do not globally rewrite the `Switch` primitive in Phase 4 unless the SettingsPanel row contract cannot be made accessible locally.

### Testing And Verification

- **D-19:** Add/update source tests for `ThreadCanvas` that assert token usage, safe-area/composer token consumption, and absence of `max-w-[44rem]` and `px-4 md:px-8`.
- **D-20:** Add/update source tests for `SettingsPanel` that assert shared single-page structure, token-based content width/gutters, compact dense-region fallback, mobile-safe tabs, and switch-row touch contracts.
- **D-21:** Keep Phase 4 automated verification focused on source/unit, lint, and build. Real viewport checks for keyboard and safe-area behavior remain Phase 5 acceptance.

### the agent's Discretion

- The exact Tailwind syntax can be chosen by the planner/executor as long as layout values come from existing CSS variables and no new duplicate mobile/tablet token family is introduced.
- The compact secondary composer action layout can be wrap or horizontal scroll; choose the simpler option that preserves readability and does not require a new menu system.
- Settings dense-region card styling can reuse existing `SETTINGS_EMBEDDED_PANEL_*` patterns if they remain readable and do not add visual noise.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project And Roadmap

- `.planning/PROJECT.md` — Defines the unified UI architecture, constraints, and no-new-library guardrails.
- `.planning/REQUIREMENTS.md` — Defines `TOKN-03`, `THRD-01` through `THRD-05`, and `SETT-01` through `SETT-06`.
- `.planning/ROADMAP.md` — Defines Phase 4 goal, dependencies, primary files, and success criteria.
- `.planning/STATE.md` — Captures completed Phase 1-3 decisions and current Phase 4 focus.

### Prior Phase Contracts

- `.planning/phases/01-responsive-policy-foundation/01-CONTEXT.md` — Locks responsive policy direction and defers content surfaces to Phase 4.
- `.planning/phases/02-root-state-and-layout-tokens/02-CONTEXT.md` — Locks root datasets and shared token strategy.
- `.planning/phases/02-root-state-and-layout-tokens/02-01-SUMMARY.md` — Lists the layout tokens now available for content consumption.
- `.planning/phases/03-shell-and-sidebar-adaptation/03-CONTEXT.md` — Locks compact shell/sidebar behavior and keeps content surfaces for Phase 4.
- `.planning/phases/03-shell-and-sidebar-adaptation/03-01-SUMMARY.md` — Confirms compact shell behavior is stable for content work.

### Historical UI Adaptation Plans

- `docs/plans/2026-03-19-win-tablet-mobile-ui-adaptation-executable-todo.md` — Current broader execution plan; Phase 4 section calls for ThreadCanvas token consumption, composer safe-area handling, settings single page, and AppChrome settings scroll padding calibration.
- `docs/plans/2026-03-17-mobile-tablet-adaptation-executable-todo.md` — Historical plan; captures ThreadCanvas tokenization and SettingsPanel dense-region degradation rationale.
- `UI优化方案.md` — Prior UI audit; highlights responsive design, switch sizing, ThreadCanvas controls, and mobile-first concerns.

### Code

- `src/components/content/ThreadCanvas.tsx` — Main thread empty state and composer surface to adapt.
- `src/components/content/ThreadCanvas.source.test.ts` — Existing source contracts to update from desktop width assertions to token/safe-area assertions.
- `src/components/content/SettingsPanel.tsx` — Large shared settings surface with rows, blocks, tabs, switches, dialogs, and dense pseudo-table regions.
- `src/components/content/SettingsPanel.source.test.ts` — Existing source contracts to extend for mobile-safe settings behavior.
- `src/components/content/settings-control-styles.ts` — Existing switch/control wrapper constants that may be reused for touch-friendly rows.
- `src/components/content/settings-actions.ts` — Existing settings action button class contract.
- `src/components/content/settings-input-styles.ts` — Existing settings input class contract.
- `src/components/ui/tabs.tsx` — Tabs primitive wrapper; only update if SettingsPanel-local classes cannot satisfy compact behavior.
- `src/components/ui/switch.tsx` — Switch primitive wrapper; avoid global rewrite unless local row contract is insufficient.
- `src/styles/app.css` — Existing layout, safe-area, workspace, composer, and touch target tokens.
- `src/styles/app.source.test.ts` — Existing token source tests; add only if new shared token names are truly required.
- `src/components/shell/AppChrome.tsx` — Settings scroll wrapper currently owns padding/top/bottom spacing; minimal tokenization edit is allowed for `SETT-05`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `ThreadCanvas` already has a simple single-column empty state and a bottom composer; this is the right structure to token-drive rather than replace.
- `app.css` already exposes `--workspace-max-width`, `--composer-max-width`, `--composer-min-height`, `--composer-bottom-offset`, `--page-gutter-inline`, `--page-gutter-block`, and `--layout-safe-area-*`.
- `SettingsPanel` already centralizes much layout through `SettingsSection`, `SettingBlock`, and `SettingsRow`; these are the right places to absorb responsive changes.
- `settings-control-styles.ts`, `settings-actions.ts`, and `settings-input-styles.ts` already define reusable class contracts for settings controls.
- Existing `Tabs`, `Switch`, `Button`, `Input`, and `Textarea` primitives are sufficient; no new UI dependency is needed.

### Established Patterns

- Source tests are used heavily to lock structural UI contracts.
- Existing styling uses Tailwind v4 plus CSS variables from `app.css`; avoid CSS-in-JS and hard-coded colors.
- The project prefers quiet, compact, single-column settings structure over showcase-style panels or duplicated navigation.
- Phase 2 established dataset-driven token overrides; Phase 4 components should consume those tokens rather than add local breakpoint policy.

### Current Risk Points

- `ThreadCanvas` still has `px-4 md:px-8`, `max-w-[44rem]`, and composer width constants that duplicate layout tokens.
- `ThreadCanvas` composer footer uses fixed padding and does not yet consume safe-area left/right/bottom aliases.
- `SettingsPanel` still has `max-w-[46rem]`, dense pseudo-table `grid-cols-[0.8fr_1.5fr_1.2fr_0.7fr_0.7fr_0.8fr]`, several desktop-first grids, and fixed preview dialog widths.
- `SettingsRow` switch controls are visually wrapped, but the full setting row is not yet the touch target.
- `TabsList` usages in SettingsPanel are compact visually but not explicitly full-width/equal-width on phone.

### Integration Points

- `AppChrome` wraps settings content in the scroll container; tokenizing settings page gutters may require a minimal edit there even though the main work is in SettingsPanel.
- `SettingsPanel` receives `activeTab` and `onSelectTab`; Phase 4 should not change navigation semantics or settings data flow.
- `ThreadCanvas` is lazy-loaded from `App.tsx`; Phase 4 should keep the same exported component and avoid app-level state changes.

</code_context>

<specifics>
## Specific Ideas

- Compact composer should feel input-first: textarea and send button are the primary path; attachment/model/strength actions should be visually secondary.
- Settings dense data should read like cards/definition lists on compact screens, not a squeezed desktop table.
- Short tab groups should look deliberate on phone by occupying available width instead of floating as tiny desktop pills.
- Switch rows should be comfortable to tap without needing to hit only the switch thumb/control.

</specifics>

<deferred>
## Deferred Ideas

- Real mobile keyboard detection as an explicit environment signal is v2/Phase 5+ follow-up unless real-device validation proves it is needed immediately.
- Global Button/Input/Textarea/Switch primitive touch target audit remains Phase 5.
- Tablet landscape rail mode remains v2 after compact drawer behavior is stable.
- Manual viewport/device validation remains Phase 5.

</deferred>

---
*Phase: 04-content-surface-adaptation*
*Context gathered: 2026-04-23*
