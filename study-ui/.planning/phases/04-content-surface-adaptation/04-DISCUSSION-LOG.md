# Phase 4: Content Surface Adaptation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-23
**Phase:** 4 - Content Surface Adaptation
**Areas discussed:** Thread canvas layout, Composer behavior, Settings layout, Dense settings regions, Tabs and switches, Testing

---

## Thread Canvas Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Token-driven single column | Reuse `--workspace-max-width`, `--page-gutter-*`, and safe-area tokens while keeping the existing quiet single-column structure. | yes |
| New mobile thread page | Fork a separate mobile `ThreadCanvas` variant. | |
| Keep desktop classes | Keep `max-w-[44rem]` and `px-4 md:px-8`. | |

**User's choice:** Token-driven single column, inferred from the user's original research direction.
**Notes:** The user explicitly asked for one component set and token-driven adaptation, not a separate mobile UI.

---

## Composer Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Input-first shared composer | Keep one composer, prioritize textarea/send on compact screens, and move secondary actions into wrap or horizontal secondary layout. | yes |
| Full desktop action row everywhere | Keep attachment/model/reasoning controls equally prominent on phone. | |
| New compact action menu | Add a new menu system just for secondary composer actions. | |

**User's choice:** Input-first shared composer, inferred from Phase 4 requirements and prior research.
**Notes:** New menus are not required for this phase unless simple wrapping/scrolling fails.

---

## Settings Layout

| Option | Description | Selected |
|--------|-------------|----------|
| One shared responsive page | Keep `SettingsPanel` as one page and concentrate responsive behavior in shared row/block/section helpers. | yes |
| Separate mobile settings page | Duplicate the settings surface for phone. | |
| Horizontal overflow desktop page | Preserve desktop layout and rely on scrolling/overflow on compact screens. | |

**User's choice:** One shared responsive page.
**Notes:** This was explicitly stated in the user's initial Phase 4 research conclusion.

---

## Dense Settings Regions

| Option | Description | Selected |
|--------|-------------|----------|
| Cards / definition lists below desktop | Keep desktop density where useful, but show compact rows as labeled cards or definition lists. | yes |
| Horizontal table scroll | Preserve pseudo-table and let users scroll sideways. | |
| Remove dense data | Hide dense settings data on mobile. | |

**User's choice:** Cards / definition lists below desktop.
**Notes:** This directly maps to `SETT-02` and the user's original "表格降级成卡片/definition list" direction.

---

## Tabs And Switches

| Option | Description | Selected |
|--------|-------------|----------|
| Local SettingsPanel adaptations | Use full-width/equal-width short tabs and row-level switch targets inside SettingsPanel first. | yes |
| Global primitive rewrite first | Change Tabs/Switch primitives globally before proving SettingsPanel needs it. | |
| Leave controls as-is | Keep current compact desktop control behavior. | |

**User's choice:** Local SettingsPanel adaptations.
**Notes:** This limits blast radius while satisfying Phase 4 requirements. Phase 5 can audit primitives globally.

---

## Testing

| Option | Description | Selected |
|--------|-------------|----------|
| Source contracts plus lint/build | Update source tests for token usage and compact degradation, then run lint/build. | yes |
| Full visual/device validation now | Block Phase 4 on real device checks. | |
| No new tests | Rely on manual inspection only. | |

**User's choice:** Source contracts plus lint/build.
**Notes:** Real keyboard/safe-area device checks remain Phase 5 because source tests cannot prove WebView keyboard behavior.

---

## the agent's Discretion

- Exact Tailwind syntax for CSS variables can be chosen during planning/execution.
- Secondary composer action layout can be wrapping or horizontal scrolling as long as input/send remain primary.
- Dense cards can reuse existing settings panel class constants if the result stays readable.

## Deferred Ideas

- Explicit mobile keyboard environment signal.
- Global primitive touch-target audit.
- Tablet landscape rail mode.
- Manual viewport/device validation.
