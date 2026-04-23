---
phase: 5
slug: touch-targets-and-verification
status: approved
shadcn_initialized: true
preset: new-york
created: 2026-04-23
approved: 2026-04-23
---

# Phase 5 — UI Design Contract

> Visual and interaction contract for completing control touch targets and verification. This phase is intentionally narrow: it locks mobile/tablet interaction density, preserves desktop compactness, and creates acceptance evidence without changing the product's visual direction.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn/ui style primitives already present in the repo |
| Preset | new-york |
| Component library | Radix UI wrappers in `src/components/ui/*` |
| Icon library | Phosphor Icons (`@phosphor-icons/react`) |
| Font | Existing `--app-font-family`; no new font |
| Styling | Tailwind CSS v4 + CSS variables in `src/styles/app.css` |

### Non-Negotiables

- Do not create separate mobile control primitives or duplicate mobile-only components.
- Do not introduce CSS-in-JS, new UI libraries, new responsive libraries, or new E2E dependencies unless existing project infrastructure is discovered.
- Treat `phone < 640` and `tablet 640-1023` as touch density. Do not shrink touch targets at `md`.
- Desktop compact sizing begins at `desktop >= 1024`, preferably via `lg:` classes or `data-density="compact"` token behavior.
- A touch target is the clickable/focusable interaction area, not necessarily the visible chrome. The visible switch track can stay compact if the hit area remains at least 44px.
- All implementation choices must be backed by source/unit tests and a committed manual acceptance checklist.

---

## Touch Target Contract

| Rule | Contract |
|------|----------|
| Canonical token | `--touch-target-size` is the source of truth for phone/tablet hit targets. |
| Touch minimum | Phone/tablet controls expose at least `2.75rem` / `44px` in width and height where the control is square or standalone. |
| Desktop compactness | Desktop controls may return to existing compact tokens such as `--button-height`, `--button-height-sm`, and `--button-icon-size`. |
| Breakpoint safety | Avoid `md:h-*`, `md:min-h-*`, or `md:size-*` as the first compacting override for touch targets because `md` includes tablets. |
| Density safety | Prefer `lg:` or root `data-density`/token behavior when switching from touch to compact sizing. |
| Focus safety | Focus rings must remain visible and not be clipped by invisible hit-area wrappers. |
| Overlap safety | Expanded hit areas must not overlap adjacent controls or steal pointer events from neighboring actions. |

### Required Control Outcomes

| Control | Phone/Tablet Contract | Desktop Contract |
|---------|------------------------|------------------|
| `Button` default | `h-11` or `min-h-[var(--touch-target-size)]`; no tablet shrink. | Can use `--button-height` at `lg` or compact density. |
| `Button` `sm` | Minimum hit height is 44px on touch density even if label typography remains compact. | Can use `--button-height-sm`. |
| `Button` `icon` | Minimum hit box is 44x44 on touch density; icon glyph can remain 16px. | Can use 32x32 compact icon size. |
| `ShellButton` nav | Drawer/tablet nav rows stay at least 44px. | Docked desktop nav may use compact row height. |
| `ShellButton` icon | Topbar/drawer icon controls are 44x44 on touch density. | Titlebar/sidebar icon controls may compact to 32x32. |
| `Input` | Height remains at least 44px through the full `<1024` compact range. | Can compact to 40px on desktop. |
| `Textarea` | Existing tall `min-h-28` remains; no compact shrink below 44px. | Existing sizing may remain. |
| `Switch` | The Radix root or a required wrapper exposes at least 44x44; row-level labels can also toggle where used. | Visible track can remain compact; desktop hit target can be smaller if not required by context. |
| Composer send | Send action remains visible and at least 44x44. | Can preserve current desktop visual sizing. |
| Composer secondary actions | `size="sm"` controls are touch-safe on phone/tablet and must not push input/send out of reach. | Can return to compact secondary controls. |

---

## Component-Level Contracts

### Button Primitive

- `buttonSizeClassNames.default`, `sm`, `lg`, and `icon` must be audited together.
- If class-based responsive sizing is used, desktop compaction must use `lg:` rather than `md:`.
- If token-based sizing is used, tokens must be density-aware without adding `mobile-*` or `tablet-*` families.
- Keep typography compact: `text-xs`, `text-[13px]`, and `text-sm` remain acceptable as long as the hit area is 44px.
- Do not add scale animations or decorative hover effects.

### ShellButton

- `variant="nav"` must not shrink tablet rows via `md:min-h-*`.
- `variant="icon"` and `size="icon"` must be 44x44 in drawer/topbar contexts.
- Desktop shell/titlebar behavior from Phase 3 must remain unchanged: drag regions, window controls, and docked sidebar behavior are protected.
- Shell buttons should continue reusing shared button tone tokens instead of introducing shell-only colors.

### Input And Textarea

- `Input` must stay 44px high through tablet widths; a desktop-only shrink is allowed at `lg`.
- `Textarea` can keep `min-h-28`, `rounded-2xl`, and existing text rhythm.
- Placeholder, focus, disabled, and background treatment stay unchanged.

### Switch

- Preserve Radix `SwitchPrimitive.Root` and `SwitchPrimitive.Thumb`.
- The visible switch can stay close to the current 52x32 visual track if an outer hit area or density-aware root sizing provides a 44px target.
- Row-level settings labels should remain clickable where Phase 4 introduced row interaction.
- The focus ring must visually identify the switch target even if the hit area is larger than the track.

### Thread Composer

- Text input and send button remain the primary compact interaction.
- Secondary action buttons can wrap or remain in a secondary row, but every tappable item must meet the touch target contract.
- Do not introduce new composer toolbar structure in Phase 5 unless required to keep 44px targets from overlapping.

### Settings Controls

- Keep Phase 4 single-page settings architecture.
- Preference rows keep `min-h-[var(--touch-target-size)]` or an equivalent row-level target.
- Tabs and segmented controls keep compact equal-width/scroll-safe behavior from Phase 4.
- Dense settings cards should not be visually reworked in this phase; only test or target-size regressions should be addressed.

---

## Spacing Scale

Declared values align to the existing 4px rhythm and app tokens.

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon/text gaps, switch inner padding |
| sm | 8px | Compact control gaps |
| md | 16px | Control group spacing and compact row padding |
| lg | 24px | Section/card spacing inherited from Phase 4 |
| xl | 32px | Desktop layout spacing only |
| touch | 44px | Minimum touch target on phone/tablet |

Exceptions:

- Safe-area tokens may resolve to non-4px values.
- Existing button tokens such as `--button-height-sm: 1.875rem` may remain for desktop compact density only.
- Invisible hit-area padding is allowed only if it preserves focus visibility and does not create overlapping targets.

---

## Typography

| Role | Size | Weight | Line Height | Usage |
|------|------|--------|-------------|-------|
| Button label | 12-14px | 500 | 1.0-1.3 | Compact action labels |
| Input text | 14px | 400 | 1.4-1.6 | Inputs and textarea |
| Settings label | 14px | 500-600 | 1.3-1.5 | Row labels |
| Helper text | 12-14px | 400 | 1.4-1.6 | Settings descriptions |
| Display | Not used | Not used | Not used | Phase 5 adds no display typography |

Rules:

- Do not enlarge typography to solve touch targets. Increase hit area, not visual noise.
- Keep all UI text within the existing 11-24px scale.
- Preserve Chinese copy rhythm and avoid uppercase tracking-heavy labels.

---

## Color

Use existing semantic tokens only.

| Role | Token | Usage |
|------|-------|-------|
| Dominant | `bg-background`, `bg-shell-panel`, `bg-shell-panel-strong` | App and shell surfaces |
| Secondary | `bg-secondary`, `bg-card`, `bg-input` | Buttons, cards, input surfaces |
| Accent | `bg-primary`, `text-primary`, `bg-primary/12` | Primary send/toggle selected state only |
| Interaction | `bg-interactive-hover`, `bg-interactive-selected` | Hover, active, selected rows |
| Focus | `ring-ring` | Keyboard and accessibility focus |
| Border | `border-border`, shell/composer border tokens | Control boundaries and dividers |
| Destructive | `text-destructive`, `bg-destructive` | Destructive actions only |

Avoid:

- New hard-coded color values in component classes.
- New gradients, glass effects, strong shadows, or decorative mobile-only color treatments.
- Purple or neon emphasis not already part of the active theme tokens.

---

## Interaction Contract

- Pointer, keyboard, and screen-reader interaction must remain equivalent after hit-area expansion.
- Row-level settings switches must allow tapping/clicking the row without breaking Radix switch semantics.
- Disabled controls keep `disabled:pointer-events-none disabled:opacity-50` or the local equivalent.
- Hover is desktop-only enhancement; compact touch states should rely on active/focus-visible feedback.
- Motion remains limited to color/background/box-shadow transitions of 150ms and existing reduced-motion handling.
- Do not use scale, bounce, spring, or route/page animations.

---

## Copywriting Contract

Phase 5 should not introduce new product-facing copy. Preserve existing labels and `aria-label` text.

| Element | Contract |
|---------|----------|
| Composer send | Keep `发送消息` or existing accessible send label. |
| Shell navigation | Preserve existing nav item labels and drawer trigger labels. |
| Settings switch rows | Preserve current titles/descriptions; do not rewrite product semantics. |
| Manual checklist | Use direct pass/fail language: viewport, expected behavior, observed result, status. |
| Error state | Not introduced in Phase 5 unless an existing verification command fails. |

---

## Responsive Contract

| Form Factor | Contract |
|-------------|----------|
| Phone `<640` | All standalone and row-level controls expose 44px targets; composer input/send remain primary; no horizontal scroll caused by expanded controls. |
| Tablet `640-1023` | Same touch target contract as phone. Tablet must not inherit compact desktop sizing from `md:` classes. |
| Desktop `>=1024` | Compact button/icon/switch visual sizes are allowed; docked shell and titlebar behavior remain unchanged. |

Manual viewport targets:

- `390x844` phone
- `768x1024` tablet portrait
- `834x1194` tablet large portrait
- `1024x768` desktop minimum boundary
- `1280x800` wider desktop

---

## Manual Acceptance Contract

Phase 5 implementation must create a committed manual acceptance artifact, preferably `05-MANUAL-ACCEPTANCE.md` or the UAT document if the verifier owns final acceptance.

| Viewport | Required Observations |
|----------|-----------------------|
| `390x844` | Topbar controls, drawer nav rows, composer send/secondary actions, settings switches, tabs, and inputs are tappable without crowding. |
| `768x1024` | Tablet controls remain 44px; no `md:` shrink regression; settings rows and composer controls remain touch-safe. |
| `834x1194` | Large tablet keeps compact drawer behavior and touch density while benefiting from wider layout tokens. |
| `1024x768` | Desktop boundary uses docked shell, compact desktop controls are acceptable, and content does not overflow. |
| `1280x800` | Wider desktop preserves titlebar, sidebar dock/collapse, window controls, resize handles, and compact density. |

Manual status vocabulary:

- `PASS`: observed and acceptable.
- `FLAG`: acceptable for this phase but worth follow-up.
- `FAIL`: blocks Phase 5 completion.
- `N/A`: unavailable in the local environment, with reason.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | Existing `Button`, `Input`, `Textarea`, `Switch`, `Tabs`, `Dialog`, `Sheet` wrappers only | No registry install required |
| Third-party registry | None | Blocked |
| New component library | None | Blocked |

Allowed edits:

- Shared control class/token edits in `Button`, `ShellButton`, `Input`, `Textarea`, and `Switch`.
- Minimal `app.css` token edits if they are density-neutral and reuse existing dataset state.
- Source/unit test updates and manual acceptance docs.

Blocked edits:

- New dependency installs.
- A second mobile component set.
- Product copy rewrites or visual redesign outside touch target clarity.

---

## Source Test Contract

| File | Required Assertions |
|------|---------------------|
| `src/styles/app.source.test.ts` | `--touch-target-size` remains canonical; no duplicate `--mobile-*` or `--tablet-*` control token family. |
| `src/components/ui/button.source.test.ts` | Default, `sm`, and `icon` button variants are touch-safe before desktop compaction; desktop compaction does not start at `md`. |
| `src/components/shell/ShellButton.source.test.ts` | Nav and icon shell controls meet compact touch targets and stale Phase 4 class expectations are repaired. |
| `src/components/ui/input.source.test.ts` | Input stays 44px through compact/tablet widths; desktop shrink is `lg` or density-driven. |
| `src/components/ui/textarea.source.test.ts` | Textarea keeps a minimum height greater than 44px and preserves focus/disabled styling. |
| `src/components/ui/switch.source.test.ts` | Switch exposes a 44px phone/tablet hit target while preserving Radix root/thumb semantics. |
| `src/components/content/ThreadCanvas.source.test.ts` | Composer send and secondary controls remain touch-safe and token-driven. |
| `src/components/content/SettingsPanel.test.ts` | Stale responsive tab expectation is updated; compact settings control rows remain touch-safe. |

Targeted verification should also include existing responsive policy, app layout policy, AppChrome, Sidebar, Titlebar, and app-shell tests.

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS — No new product copy; manual acceptance wording is operational and specific.
- [x] Dimension 2 Visuals: PASS — Preserves current quiet UI and changes interaction area rather than adding visual bloat.
- [x] Dimension 3 Color: PASS — Uses existing semantic tokens only.
- [x] Dimension 4 Typography: PASS — Keeps the existing 11-24px scale and does not enlarge type to fake touch size.
- [x] Dimension 5 Spacing: PASS — Defines 44px touch target rules and blocks tablet-breaking `md:` compaction.
- [x] Dimension 6 Registry Safety: PASS — No new UI library, registry block, dependency, or CSS-in-JS is allowed.

**Approval:** approved 2026-04-23
