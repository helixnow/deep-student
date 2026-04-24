---
phase: 7
slug: deepstudent-migration-foundation
status: approved
shadcn_initialized: true
preset: new-york
created: 2026-04-24
reviewed_at: 2026-04-24T10:26:52+0800
---

# Phase 7 — UI Design Contract

> Visual and interaction contract for moving the `study-ui` design system into the parent DeepStudent app incrementally. `study-ui` is the source of truth; parent `src/` is the implementation target. This phase unifies token bridges, primitive behavior, mobile shell/header/sidebar rules, and regression gates without rewriting unrelated product surfaces.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | `study-ui` shadcn/ui `new-york` baseline plus existing local Radix/CVA wrappers in parent `src/components/ui/shad/*`; no new root init in Phase 7 |
| Preset | `new-york` from `study-ui/components.json`; parent root currently has no `components.json`, so Phase 7 uses the `study-ui` preset as the authoritative contract |
| Component library | Radix UI wrappers plus local facades in `src/components/ui/*` |
| Icon library | Phosphor Icons for migrated shell/primitives; Lucide may remain only in untouched legacy surfaces |
| Font | Existing `--app-font-family` and `--font-family-sidebar-study-ui`; do not introduce a new font |

### Source Of Truth

- Locked decisions: `study-ui/.planning/phases/07-deepstudent-migration-foundation/07-CONTEXT.md`
- Baseline contracts: `04-UI-SPEC.md` and `05-UI-SPEC.md`
- Source token layer: `study-ui/src/styles/app.css`
- Parent bridge files: `src/styles/shadcn-variables.css` and `src/styles/theme-colors.css`
- Parent convergence targets: `src/components/ui/NotionButton.tsx`, `src/components/ui/shad/Button.tsx`, `src/components/ui/shad/Input.tsx`, `src/components/ui/shad/Switch.tsx`, `src/components/layout/MobileHeader.tsx`, `src/components/layout/UnifiedMobileHeader.tsx`, `src/components/layout/MobileSidebarNavigation.tsx`

### Non-Negotiables

- Parent `src/` is the implementation target. `study-ui` remains the design reference, not a permanent parallel shell.
- Phase 7 is a foundation phase. It must not trigger a repo-wide replacement of every `NotionButton`, raw `<button>`, or Lucide icon.
- No new UI library, CSS-in-JS system, dependency swap, registry, or third-party block is allowed.
- Literal colors are allowed only in `study-ui/src/styles/app.css`, `src/styles/shadcn-variables.css`, and `src/styles/theme-colors.css`.
- Phone and tablet remain touch density through `<1024px`; compaction may begin only at `lg` / `>=1024px`.
- Desktop Tauri behavior is protected: titlebar, drag regions, window controls, resize handles, and desktop density must not regress.

---

## Spacing Scale

Declared values align to the existing Phase 4/5 contract and the `study-ui` token rhythm.

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon gaps, inline padding, chip spacing |
| sm | 8px | Compact control gaps, row inner spacing |
| md | 16px | Default element spacing, mobile page gutter |
| lg | 24px | Section padding, tablet/desktop gutter |
| xl | 32px | Layout gaps, large surface padding |
| 2xl | 48px | Major section breaks |
| 3xl | 64px | Page-level spacing only |

Exceptions: `--touch-target-size` is `44px` below `lg`; `--layout-safe-area-*`, `--composer-bottom-offset`, and mobile header total height may resolve to non-4px values; desktop icon compaction may return to `32px` only at `lg`.

---

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 14px | 400 | 1.5 |
| Label | 12px | 600 | 1.2 |
| Input | 16px | 400 | 1.5 |
| Heading | 20px | 600 | 1.2 |

Rules:

- Display typography is not used in this phase.
- `16px` is reserved for primary text input, composer text, and long-form content, not shell chrome.
- In migrated primitives and shell surfaces, only weights `400` and `600` are allowed.
- Do not introduce new sizes above `24px`, marketing display type, or uppercase tracking-heavy labels.
- Preserve the restrained `study-ui` rhythm already established in Phases 4-6.

---

## Visual Hierarchy Contract

| Surface | Primary Focal Point | Secondary Elements | Accessibility Contract |
|---------|---------------------|--------------------|------------------------|
| Root chat shell | Composer input and `发送消息` action | Compact menu, `新建对话`, active sidebar row | Icon-only actions require `aria-label`; focus ring uses `--ring`. |
| Mobile header/sidebar | 44px menu affordance and active navigation row | Secondary nav metadata and close actions | Labels remain visible in nav rows; close buttons keep `关闭...` screen-reader text. |
| Settings sheet/drawer | Current settings category and active tab | Row descriptions, switches, helper text | Row-level switch labels remain tappable; no focus ring clipping. |
| Desktop shell | Docked sidebar active row and main workspace content | Titlebar actions and window controls | Desktop chrome keeps drag/window affordances distinct from content actions. |

Visual rules:

- Migrated surfaces should feel quieter after migration, not more decorative.
- Primary action emphasis comes from accent tokens and placement, not large hero type, gradients, or scale animation.
- Sheet/drawer surfaces must look like the same product family as the root shell.

---

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `var(--background)` / `var(--shell-panel)` | Root workspace, sheet/dialog foundations, primary content surfaces |
| Secondary (30%) | `var(--card)` / `var(--sidebar)` / `var(--shell-panel-strong)` | Cards, sidebar/nav, secondary chrome, inset panels |
| Accent (10%) | `var(--primary)` / `var(--ring)` | Primary CTA fill, selected navigation/tab state, checked switch state, focus emphasis |
| Destructive | `var(--destructive)` | Destructive buttons, destructive text, destructive confirmation only |

Accent reserved for: `新建对话`, `发送消息`, selected sidebar rows, selected settings tabs, checked switch states, and existing positive inline counts/status that already map to primary. Accent is not allowed for decorative gradients, idle toolbar backgrounds, mobile sheet backgrounds, or arbitrary icon tinting.

---

## Semantic Tokenization Contract

| Token Family | `study-ui` Source | Parent Target | Contract |
|--------------|-------------------|---------------|----------|
| Surface + text | `--background`, `--foreground`, `--card`, `--popover`, `--secondary`, `--muted`, `--accent` | `src/styles/shadcn-variables.css` and `src/styles/theme-colors.css` | Parent bridge files must expose the same semantics. Migrated components may consume only semantic tokens, never local fallback palettes. |
| Sidebar + shell | `--sidebar*`, `--shell-*`, `--overlay`, `--interactive-*` | `src/styles/theme-colors.css` | `MobileHeader`, `UnifiedMobileHeader`, `MobileSidebarNavigation`, `src/components/ui/unified-sidebar/*`, sheet headers, and close controls must use this family only. |
| Buttons | `--button-*`, `--button-radius`, `--button-icon-size` | both bridge files plus shared primitive contract | Parent button tones and sizes must resolve from the same token family used by `study-ui`. No component-local replacement palettes. |
| Input + focus + destructive | `--input`, `--border`, `--ring`, `--destructive*` | both bridge files | Migrated `Input`, `Switch`, `Dialog`, `Sheet`, and focus states must use these tokens. No local `rgba(...)` focus rings. |
| Density + touch | `--control-height-touch`, `--control-height-compact`, `--touch-target-size`, `--button-height*` | `src/styles/shadcn-variables.css` | `--touch-target-size` is the only canonical touch sizing token for primitives below `lg`. Do not size migrated primitives from `--size-shell-touch-target`, `--size-shell-touch-target-lg`, or page-local utility math. |

Token rules:

- If the parent app needs an alias, define it once in a token file and map it back to an existing `study-ui` semantic token.
- Do not invent parallel families such as `--mobile-button-*`, `--tablet-button-*`, `--study-sidebar-blue`, or surface-local `--ios-sheet-*`.
- Component class strings in migrated files must not contain literal `#...`, `rgb(...)`, `rgba(...)`, `shadow-black/...`, or `bg-gradient-*` values.

---

## Primitive Convergence Contract

The parent app currently contains `304` `NotionButton` imports, `20` `ui/shad/Button` imports, and `348` raw `<button>` occurrences in `src/`. Phase 7 does not replace them globally. It establishes one shared primitive contract and applies it to root shell, mobile header/sidebar, settings sheet/drawer, and other explicitly migrated surfaces first.

| Area | Contract |
|------|----------|
| Button facade | `NotionButton` and `src/components/ui/shad/Button.tsx` must converge on one shared base, tone, and size contract. Either one wraps the other, or both import one common class-map module. New migrated shell work must not choose between separate button behaviors. |
| Button sizes | Below `lg`, `default`, `sm`, and `icon` variants use `h-[var(--touch-target-size)]` or an explicit `44px` minimum. At `lg`, they may compact to the `study-ui` `--button-height*` and `--button-icon-size` tokens. |
| Nav rows | Sidebar and sheet navigation rows follow `min-h-[2.75rem]` below `lg`; any desktop compaction switches with `lg:min-h-9`, never `md:min-h-9`. |
| Input | `src/components/ui/shad/Input.tsx` must expose a `44px` minimum height below `lg`. `py-2` alone is not an acceptable source of truth. |
| Switch | `src/components/ui/shad/Switch.tsx` may keep a compact visible track, but the interactive root or row wrapper must expose at least `44x44` below `lg`. |
| Sheet and drawer close controls | Close buttons stay `44x44` below `lg`, `32x32` at `lg`, and use tokenized hover/focus only. No sheet-local palette overrides. |
| Header menu buttons | `MobileHeader` and `UnifiedMobileHeader` must reuse the shared shell icon-button contract instead of inlining `bg-card/85`, `shadow-black/5`, or custom button chrome. |
| Sidebar navigation | `MobileSidebarNavigation` and `src/components/ui/unified-sidebar/*` must use the same nav-row contract as `study-ui` `ShellButton` or a shared wrapper/facade. No raw local palette logic in migrated rows. |

---

## Touch Density Contract

| Control | Phone / Tablet `<1024` | Desktop `>=1024` |
|---------|------------------------|------------------|
| Primary and secondary buttons | Minimum `44px` height | May compact to `32-40px` depending on shared token |
| Icon buttons | Minimum `44x44` hit box | May compact to `32x32` |
| Nav rows | Minimum `44px` height | May compact to `36px` row height if the shared desktop shell contract requires it |
| Input | Minimum `44px` height | May compact after `lg` only |
| Switch | Minimum `44x44` hit area | Visible track may remain compact |
| Sheet close controls | Minimum `44x44` | `32x32` allowed |

Touch-density rules:

- `md:` shrink is forbidden for migrated primitives because `md` still includes tablets.
- `lg:` is the first valid breakpoint for primitive compaction.
- The `.touch-target` utility remains an escape hatch for legacy surfaces, not the primary sizing mechanism for migrated primitives.
- Page-local overrides such as `!h-7`, `!w-7`, `h-8`, `w-8`, and `minHeight: 36` are blocked on migrated shell/header/sidebar/settings-sheet controls.

---

## Icon Transition Contract

- All newly migrated shell, header, sidebar, button, switch, and sheet-close surfaces use `@phosphor-icons/react`.
- Existing Lucide usage may remain in untouched product pages until those surfaces migrate.
- Do not mix Phosphor and Lucide inside the same migrated primitive or the same migrated shell surface.
- Do not attempt a repo-wide icon conversion in Phase 7. The root app is still Lucide-heavy, and that cleanup belongs to later surface phases.
- Default migrated icon sizing: `18px` for standard controls, `20px` for nav rows, `21px` for the compact menu affordance used by mobile shell toggles.

---

## Motion And Visual Prohibitions

| Allowed | Blocked |
|---------|---------|
| `transition-colors duration-150`, `transition-opacity duration-150`, `transition-[width] duration-200`, and `Sheet`/drawer slide motion | `active:scale-*`, button-local `transition-transform`, spring/bounce motion, Framer `type: "spring"` in migrated shell/primitives |
| Tokenized shadows defined in token files | `shadow-black/*`, `shadow-[...]`, component-local RGBA shadows |
| Semantic token surfaces and borders | Literal `#...`, `rgb(...)`, `rgba(...)`, `bg-card/85`, `bg-gradient-*`, custom sheet palettes inside component class strings |
| Tokenized background, border, and ring feedback | Decorative glow, glass, marketing gradients, or iOS-style press effects in migrated shell surfaces |

Motion rule:

- Interaction feedback in migrated primitives must come from tokenized background, border, opacity, or ring changes only.
- Existing shell width/translate transitions already present in `study-ui` may be mirrored when they are structural and non-decorative.
- Reduced motion behavior must continue to disable optional transitions.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | `新建对话` |
| Empty state heading | `开始一个新任务` |
| Empty state body | `在底部输入框发送你的需求。不要新增升级入口、账户增长入口或第二套营销式建议卡片。` |
| Error state | `界面加载失败，请刷新当前页面；若仍失败，返回主界面后重试。` |
| Destructive confirmation | `无新增破坏性操作`：本阶段不新增删除或重置入口；如迁移已有破坏性操作，确认文案统一为 `此操作不可恢复，确认继续？` |

Copy rules:

- Preserve `发送消息`, `关闭系统设置`, `展开侧边栏`, and existing settings category labels if those surfaces migrate.
- Do not introduce `Submit`, `Save`, `OK`, marketing prompts, upgrade language, or product-growth entry points.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | Existing local wrappers aligned to `Button`, `Input`, `Sheet`, `Switch`, `Tabs`, `Dialog`, `Textarea`, and `Tooltip` only | No new install required; authoritative preset is `study-ui/components.json` |
| Third-party registry | None | Blocked by phase policy |

---

## Verification Gates

| Gate | Required Evidence |
|------|-------------------|
| Token bridge parity | Source test or static snapshot proves the parent bridge exposes `study-ui` surface, text, sidebar, shell, button, input, focus, destructive, and touch-density token families. |
| Primitive shared contract | Source test proves `NotionButton` and `ui/shad/Button` share one exported size/tone contract or a single facade relationship. |
| Touch safety | Static/source checks for migrated primitives reject `md:min-h-*`, `md:h-*`, `minHeight: 36`, `h-7`, `h-8`, `w-8`, and other `<44px` touch sizing below `lg`. |
| Color guard | Grep/static gate over targeted migrated files rejects `#`, `rgb(`, `rgba(`, `bg-card/85`, `shadow-black/`, `shadow-[`, and `bg-gradient` outside token definition files. |
| Motion guard | Grep/static gate over targeted migrated files rejects `active:scale`, `spring`, `ease-spring`, and button-local transform press feedback; only `Sheet`/drawer structural transforms are allowed. |
| Icon guard | Source test or lint rule proves migrated shell/header/sidebar/button files import Phosphor only. |
| Manual verification | Viewports `390x844`, `768x1024`, `834x1194`, `1024x768`, and `1280x800` cover root chat shell, mobile header/sidebar, settings sheet/drawer, close controls, and desktop Tauri chrome preservation. |

Verification scope for Phase 7:

- Root chat shell and its compact header actions
- `MobileHeader` and `UnifiedMobileHeader`
- `MobileSidebarNavigation` and mobile mode inside `src/components/ui/unified-sidebar/*`
- Settings sheet/drawer open, close, tab selection, and touch targets
- Desktop titlebar, drag region, window controls, resize handles, and minimum-window behavior

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved 2026-04-24
