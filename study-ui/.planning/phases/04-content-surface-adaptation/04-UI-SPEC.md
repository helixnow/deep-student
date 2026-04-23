---
phase: 4
slug: content-surface-adaptation
status: approved
shadcn_initialized: true
preset: new-york
created: 2026-04-23
approved: 2026-04-23
---

# Phase 4 — UI Design Contract

> Visual and interaction contract for adapting `ThreadCanvas` and `SettingsPanel` across phone, tablet, and desktop. This contract is intentionally restrained: Phase 4 solves responsive structure, safe-area spacing, dense-region degradation, and touch clarity without redesigning the product or adding a second UI system.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn/ui style primitives already present in the repo |
| Preset | new-york |
| Component library | Radix UI wrappers in `src/components/ui/*` |
| Icon library | Phosphor Icons (`@phosphor-icons/react`) |
| Font | Existing app font stack via `--app-font-family`; do not introduce a new font |
| Styling | Tailwind CSS v4 + CSS variables in `src/styles/app.css` |

### Non-Negotiables

- Do not create `MobileThreadCanvas`, `MobileSettingsPanel`, or any separate mobile page fork.
- Do not introduce CSS-in-JS, new UI libraries, new responsive libraries, or hard-coded color values.
- Do not add decorative visual effects, route motion, spring/bounce animation, or extra dashboard cards.
- Use existing shell/content visual language: quiet surfaces, readable spacing, semantic tokens, restrained shadows.

---

## Surface Contracts

### ThreadCanvas

| Area | Contract |
|------|----------|
| Layout | One shared single-column document surface; no feed/grid/timeline redesign. |
| Width | Content max width uses `--workspace-max-width`; composer max width uses `--composer-max-width`. |
| Gutters | Inline and block spacing use `--page-gutter-inline` and `--page-gutter-block`, plus safe-area aliases where needed. |
| Empty state | Keep current calm empty state copy and single primary suggestion action. Compact screens should feel slightly higher than dead-center so the composer remains visually primary. |
| Scroll | Main scroll region remains the thread content area. Avoid nested scroll traps. |

### Composer

| Area | Contract |
|------|----------|
| Primary path | Textarea + send button are always the primary compact interaction. |
| Secondary controls | Attachment/model/reasoning controls are visually secondary. They may wrap or scroll horizontally on compact widths, but must not push send/input out of view. |
| Safe area | Composer container consumes `--layout-safe-area-left`, `--layout-safe-area-right`, `--layout-safe-area-bottom`, and `--composer-bottom-offset`. |
| Send affordance | Send button remains circular and persistent. Empty state can stay quiet/disabled-looking but must retain an accessible `aria-label`. |
| Keyboard | Phase 4 does not claim full keyboard detection. The UI must be safe-area-aware and leave Phase 5 to validate real WebView keyboard behavior. |

### SettingsPanel

| Area | Contract |
|------|----------|
| Architecture | One shared settings page; responsive behavior should be centralized in `SettingsSection`, `SettingBlock`, `SettingsRow`, and small helpers. |
| Width | Settings content width must consume layout tokens; remove desktop-only `max-w-[46rem]` as the source of truth. |
| Gutters | Settings scroll/content padding should follow `--page-gutter-inline`, `--page-gutter-block`, and safe-area tokens. |
| Dense regions | Pseudo-tables degrade below desktop into labeled cards or definition-list rows. Horizontal overflow is not the primary compact solution. |
| Dialogs | Preview dialogs remain shared, but widths/padding must be viewport-safe and compact-friendly. |
| Tabs | Short 2-3 item tab groups are full-width/equal-width on compact screens; desktop may return to intrinsic sizing. Larger/variable tab sets may use horizontal scrolling. |
| Switch rows | Switch settings become row-level touch targets with clear labels. The visible switch remains a state indicator/control, not the only tap target. |

---

## Spacing Scale

Declared values align to existing Tailwind/CSS token usage and 4px rhythm.

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon gaps, tiny label spacing |
| sm | 8px | Compact control gaps, composer inner rhythm |
| md | 16px | Default mobile content gutter, card padding |
| lg | 24px | Tablet/desktop page gutter, major settings card padding |
| xl | 32px | Desktop content gutter, section separation |
| 2xl | 48px | Large empty-state vertical breathing room only |

Exceptions:

- `--page-gutter-inline`, `--page-gutter-block`, `--composer-bottom-offset`, and `--layout-safe-area-*` are canonical layout values even when they resolve to non-4px values because they include device safe-area math.
- Existing `px-4.5` style classes may remain in established settings controls if they are already part of the local design language, but new layout sizing should prefer tokens.

### Required Token Consumption

| Target | Required Token Usage |
|--------|----------------------|
| Thread content width | `max-width: var(--workspace-max-width)` or Tailwind arbitrary equivalent |
| Thread content gutters | `padding-inline: calc(var(--page-gutter-inline) + safe-area where needed)` |
| Composer width | `max-width: var(--composer-max-width)` |
| Composer bottom/side spacing | `--composer-bottom-offset` and `--layout-safe-area-*` |
| Settings content width | `--workspace-max-width` or a shared settings token only if added to `app.css` with dataset overrides |
| Touch rows | `min-height: var(--touch-target-size)` where row-level touch targets are introduced |

---

## Typography

| Role | Size | Weight | Line Height | Usage |
|------|------|--------|-------------|-------|
| Body | 14px (`text-sm`) desktop/settings; 16px (`text-base`) for compact text input where needed | 400 | 1.5-1.7 | Settings descriptions, composer text |
| Label | 12-14px | 500-600 | 1.2-1.4 | Pills, dense labels, definition-list labels |
| Heading | 18-20px (`text-lg`/`text-xl`) | 600 | 1.25-1.35 | Settings page title, section headings |
| Display | Not used | Not used | Not used | Phase 4 should not add display typography |

Rules:

- Keep the established Chinese UI rhythm; do not introduce `text-3xl` or larger.
- Dialog titles may use `text-xl` or `text-2xl` only where already established; compact dialogs should avoid oversized titles.
- Definition-list labels should be readable, not uppercase tracking-heavy dashboard labels.

---

## Color

Use semantic Tailwind tokens mapped from `app.css`. Do not hard-code new hex/rgba colors inside components.

| Role | Token | Usage |
|------|-------|-------|
| Dominant (60%) | `bg-background`, `bg-[color:var(--shell-panel-strong)]` | Content backgrounds and composer/settings surfaces |
| Secondary (30%) | `bg-secondary`, `bg-card`, `bg-[color:var(--shell-panel)]` | Cards, embedded settings panels, quiet grouped regions |
| Accent (10%) | `text-primary`, `bg-primary`, `bg-primary/12` | Send button, status emphasis, selected/positive metadata only |
| Interaction | `bg-interactive-hover`, `bg-interactive-selected` | Hover/selected tabs, choice chips, row active states |
| Border | `border-border`, `border-composer-border`, `border-[color:var(--composer-divider)]` | Separators and composer boundary |
| Destructive | `text-destructive`, `bg-destructive` | Destructive actions only |

Accent reserved for:

- Send button active/prominent state.
- Positive status labels such as enabled/model status where already present.
- Selected states only when the component pattern already uses primary.

Avoid:

- Purple gradients, decorative gradients, new glass effects, hard-coded `rgba(...)` in new component classes, and strong `shadow-2xl`.

---

## Interaction Contract

### Compact Thread Composer

- Text input must stay the widest and easiest target.
- Send button must remain visible without horizontal scrolling.
- Secondary controls can wrap under the input or use a single horizontal row; they must remain at least readable and keyboard/focus accessible.
- Focus ring must use `focus-visible:ring-ring`; no scale animations.

### Compact Settings

- Switch rows should support clicking the row or label area while preserving Radix switch semantics.
- Dense cards/definition lists need visible labels for each value.
- Tabs should avoid tiny isolated pills on phone. Use `grid w-full` or equivalent for short fixed sets.
- Dialog content should not require side scrolling at `390px` width.

### Desktop Preservation

- Desktop may retain compact density and multi-column settings grids where they improve scan speed.
- Desktop composer can keep secondary actions in one line if there is room.
- Do not change desktop shell/titlebar/sidebar contracts as part of Phase 4.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Thread empty state heading | `开始一个新任务` |
| Thread empty state body | Keep the current calm instruction: send the requirement to the bottom input; avoid adding dashboard-style suggestion blocks. |
| Composer placeholder | `请输入问题` |
| Composer send action | `发送消息` |
| Settings page heading | Use existing `settingsPageMeta[activeTab].title`; do not duplicate sidebar labels as extra page titles. |
| Dense-region labels | Use concrete nouns: `维度`, `关联模型`, `数据集`, `数据量`, `类型`, `状态`. |
| Switch row copy | Keep existing title/description. Do not rewrite product semantics while making rows touch-friendly. |
| Error state | Not introduced in Phase 4 unless existing component already has one. If needed: state the problem and the next action in one sentence. |

---

## Responsive Contract

| Form Factor | Content Surface |
|-------------|-----------------|
| Phone `<640` | Full-width token-driven content, single-column settings, card/definition-list dense regions, full-width short tabs, composer input/send primary. |
| Tablet `640-1023` | Compact behavior continues; content can use slightly wider token max width, but settings dense regions should still avoid desktop-only six-column tables unless clearly safe. |
| Desktop `>=1024` | Preserve docked shell assumptions; content can return to desktop max widths and multi-column settings grids. |

Manual viewport targets remain Phase 5, but Phase 4 implementation should be designed for:

- `390x844`
- `768x1024`
- `834x1194`
- `1024x768`
- `1280x800`

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | Existing `Button`, `Input`, `Textarea`, `Dialog`, `Tabs`, `Switch` wrappers only | No new registry install required |
| Third-party registry | None | Do not use |
| New component library | None | Blocked by project policy |

Allowed edits:

- Local component classes in `ThreadCanvas.tsx`.
- Shared helper classes/functions inside `SettingsPanel.tsx` or adjacent existing settings style files.
- Minimal `Tabs`/`Switch` wrapper edits only if local SettingsPanel classes cannot satisfy accessibility/touch behavior.
- Minimal `AppChrome.tsx` settings scroll padding tokenization only for `SETT-05`.

---

## Source Test Contract

The plan must update tests so regressions are visible before execution is considered complete.

| File | Required Assertions |
|------|---------------------|
| `ThreadCanvas.source.test.ts` | Uses `--workspace-max-width`, `--composer-max-width`, `--page-gutter-inline`, `--composer-bottom-offset`, `--layout-safe-area-*`; does not contain `max-w-[44rem]` or `px-4 md:px-8`. |
| `SettingsPanel.source.test.ts` | Keeps one shared page; settings content width/gutters consume tokens; dense pseudo-table has compact card/definition-list fallback; short tabs are compact full-width/equal-width; switch rows expose row-level touch target contract. |
| `app.source.test.ts` | Only update if new shared token names are introduced; do not create `--mobile-*` or `--tablet-*` token families. |
| `AppChrome.source.test.ts` | Update only if settings scroll wrapper is tokenized; preserve shell/sidebar/titlebar contracts. |

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS — Existing copy stays calm, specific, and task-oriented.
- [x] Dimension 2 Visuals: PASS — Contract preserves quiet single-column content and responsive card degradation without visual bloat.
- [x] Dimension 3 Color: PASS — Only semantic CSS variables and existing Tailwind tokens are allowed.
- [x] Dimension 4 Typography: PASS — Uses existing 11-24px scale and avoids display typography.
- [x] Dimension 5 Spacing: PASS — Layout spacing is token-driven with safe-area support.
- [x] Dimension 6 Registry Safety: PASS — No new registry blocks, UI libraries, or CSS-in-JS.

**Approval:** approved 2026-04-23
