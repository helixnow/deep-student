# DeepStudent Design Tokens and Color Semantics

This document summarizes the current product token system so the same visual language can be reused on the official website. It is based on the implementation in the `nightly` worktree at the time of writing.

## Source Files

The runtime token chain is loaded from [src/App.tsx](../src/App.tsx):

1. [src/styles/tailwind.css](../src/styles/tailwind.css) - Tailwind base/utilities plus native-feel interaction imports.
2. [src/styles/shadcn-variables.css](../src/styles/shadcn-variables.css) - base design tokens, neutral HSL primitives, theme palettes.
3. [src/styles/theme-colors.css](../src/styles/theme-colors.css) - semantic surface/text/brand/component tokens derived from base tokens.
4. [src/shared/styles/index.css](../src/shared/styles/index.css) - app shell consumption layer.
5. [src/styles/typography.css](../src/styles/typography.css) - global typography rules.

The interactive in-app inventory is [src/components/style-lab/TokenInspectorTab.tsx](../src/components/style-lab/TokenInspectorTab.tsx). Contract tests worth keeping in sync include [tests/vitest/themePaletteContract.test.ts](../tests/vitest/themePaletteContract.test.ts), [tests/vitest/modernSidebarColorContract.test.ts](../tests/vitest/modernSidebarColorContract.test.ts), and [tests/vitest/semanticTokenContract.test.ts](../tests/vitest/semanticTokenContract.test.ts).

## Design Direction

DeepStudent's current UI direction is a quiet, native-feeling productivity surface:

- Neutral shell first: base surfaces are pure neutral greys, with no beige or tinted UI wash.
- Accent as accent: palette changes only tune primary actions, focus rings, links, and selected states. They must not recolor background, card, border, input, or body text.
- Flat workspace: the app shell uses a mostly flat white/dark workspace. The sidebar/navigation area is the only intentional lower-contrast panel.
- Tight native controls: compact desktop controls, larger touch targets, restrained hover color changes, no hover scale by default.
- System typography: OS-native font stacks, modest sizes, normal letter spacing, and Chinese-optimized fallbacks.

For the official website, reuse this language as "calm technical clarity": neutral content pages, restrained cards, blue/default accent for CTAs, and status colors only for meaningful product state.

## Token Layers

| Layer | Source | Purpose | Website reuse |
|---|---|---|---|
| Base primitives | `--background`, `--foreground`, `--card`, `--muted`, `--border`, `--primary` | Raw theme values, usually HSL triples used as `hsl(var(--token))` | Copy as the root theme contract |
| Semantic surfaces | `--surface-*`, `--shell-*`, `--sidebar-*` | Named UI surfaces derived from base primitives | Reuse `--surface-*`; selectively reuse `--shell-*` only for app screenshots/tools |
| Text semantics | `--text-primary`, `--text-secondary`, `--text-muted`, `--text-inverse` | Stable text roles | Reuse directly |
| Component semantics | `--button-*`, `--input-shell-*`, `--composer-panel-*`, `--menu-shell-*` | Shared component appearance | Reuse button/input/menu tokens; skip composer tokens unless building a chat-like website demo |
| Brand/status | `--brand-*`, `--success`, `--warning`, `--info`, `--danger` | Brand accents and state colors | Reuse, but keep status colors sparse |
| Geometry/motion | radius, size, shadow, focus, scrollbar tokens | Native-feel rhythm | Reuse radius, shadows, focus ring, and touch target sizes |

## Base Neutral Tokens

Base HSL tokens live in `shadcn-variables.css`. Store these as HSL triples, not complete `hsl(...)` colors.

| Token | Light | Dark | Meaning |
|---|---:|---:|---|
| `--titlebar-background` | `0 0% 96%` | `0 0% 11%` | Titlebar/chrome fallback |
| `--nav-background` | `0 0% 95%` | `0 0% 0%` | Sidebar/navigation base |
| `--background` | `0 0% 100%` | `0 0% 9%` | Page/workspace root |
| `--foreground` | `220 9% 18%` | `0 0% 96%` | Primary body text |
| `--card` | `0 0% 99%` | `0 0% 12%` | Elevated/content panels |
| `--popover` | `0 0% 99%` | `0 0% 12%` | Floating popovers |
| `--secondary` | `0 0% 98%` | `0 0% 14%` | Subtle controls and tonal buttons |
| `--muted` | `0 0% 94%` | `0 0% 14%` | Muted fills |
| `--accent` | `0 0% 93%` | `0 0% 15%` | Hover/selected neutral fill |
| `--border` | `0 0% 88%` | `0 0% 18%` | Default borders |
| `--input` | `0 0% 95%` | `0 0% 14%` | Input background |

Rule: official-site theme variants should not override these neutrals inside accent palettes. This is enforced in the app by `themePaletteContract.test.ts`.

## Accent Palettes

Accent palettes override only `--primary`, `--primary-foreground`, `--ring`, `--brand-primary`, `--brand-primary-dark`, and `--primary-color`.

| Key | zh-CN label | en-US label | Light `--primary` | Dark `--primary` | Use |
|---|---|---|---:|---:|---|
| `default` | 静海蓝 | Still Blue | `215 72% 42%` | `214 64% 72%` | Main brand/website default |
| `purple` | 墨藤紫 | Ink Violet | `262 52% 42%` | `262 52% 74%` | Secondary/product intelligence moments |
| `green` | 林影绿 | Forest Ink | `154 45% 31%` | `154 42% 68%` | Learning progress, growth, success-adjacent UI |
| `orange` | 琥珀橙 | Amber | `24 78% 35%` | `32 72% 70%` | Warm highlights, caution, feature callouts |
| `pink` | 胭脂红 | Carmine | `342 58% 39%` | `340 58% 72%` | Personalization or expressive accents |
| `teal` | 青岩蓝 | Stone Teal | `184 54% 30%` | `184 48% 68%` | Research, knowledge, technical calm |
| `muted` | 石墨 | Graphite | `220 30% 38%` | `220 24% 70%` | Low-saturation enterprise/press pages |
| `paper` | 陶棕 | Clay Brown | `24 35% 32%` | `36 40% 70%` | Editorial/document-oriented pages |

The settings UI also supports `custom`; runtime code generates a safe accent-only override from the chosen hex in [src/hooks/useTheme.ts](../src/hooks/useTheme.ts).

Recommended website default:

```css
:root,
:root[data-theme-palette='default'] {
  --primary: 215 72% 42%;
  --primary-foreground: 0 0% 100%;
  --ring: 214 62% 50%;
}

:root.dark,
:root.dark[data-theme-palette='default'] {
  --primary: 214 64% 72%;
  --primary-foreground: 220 30% 10%;
  --ring: 214 58% 68%;
}
```

## Semantic Color Tokens

Use semantic tokens in page and component CSS. Avoid hardcoded hex values except media/image assets or one-off data visualization palettes.

### Surfaces

| Token | Meaning | Website guidance |
|---|---|---|
| `--surface-nav` | Navigation layer, mapped to `--nav-background` | Header/sidebar surfaces |
| `--surface-root` | Main page root | Body background |
| `--surface-root-strong` | Root mixed toward card | Large page bands |
| `--surface-elevated` | Card/elevated surface | Cards, feature panels, modals |
| `--surface-muted` | Muted neutral fill | Code gutters, quiet chips, secondary panels |
| `--surface-overlay` | Translucent card overlay | Sticky headers or floating controls |
| `--surface-divider` | Soft separator | Hairlines and section dividers |
| `--surface-panel-muted` | Muted panel blend | Form groups and recessed panels |
| `--surface-panel-strong` | Strong panel blend | Primary content panels |

### Shell and Navigation

| Token | Meaning | Website guidance |
|---|---|---|
| `--sidebar` | Navigation panel background | Use for docs/sidebar layouts |
| `--sidebar-foreground` | Navigation primary text | Sidebar item labels |
| `--sidebar-muted` | Navigation secondary text | Section labels, metadata |
| `--sidebar-border` | Navigation divider | Sidebar edge/separators |
| `--interactive-hover` | Shared hover fill | Nav rows, ghost buttons, menus |
| `--interactive-selected` | Shared selected fill | Active nav row, selected chip |
| `--shell-*` | Desktop app chrome/workspace surfaces | Mostly skip on marketing pages; use only for product-like demos |

The app shell contract is intentionally flat: `--shell-backdrop`, `--shell-panel`, `--shell-titlebar`, `--shell-surface`, and `--shell-float` all resolve to `hsl(var(--background))`. The navigation panel is the visual contrast layer.

### Text

| Token | Meaning | Website guidance |
|---|---|---|
| `--text-primary` | High-emphasis readable text | Headings, body copy |
| `--text-secondary` | Medium-emphasis text | Supporting copy, labels |
| `--text-muted` | Low-emphasis text | Metadata, placeholders |
| `--text-inverse` | Text on primary/accent background | CTA buttons on `--primary` |

### Borders and Focus

| Token | Meaning | Website guidance |
|---|---|---|
| `--border-default` | Default component border | Cards and inputs |
| `--border-soft` | Lower-emphasis divider | Section dividers |
| `--border-strong` | Emphasized border | Active panels, handles |
| `--input-shell-focus` | Focus border/ring tint | Forms and controls |
| `--ring` | Raw focus ring HSL triple | Use as `hsl(var(--ring))` in focus outlines |

### Brand and Status

| Token | Meaning | Website guidance |
|---|---|---|
| `--brand-gradient` | Primary-to-info gradient | Use sparingly for hero accent strokes or CTA surfaces |
| `--brand-50` ... `--brand-600` | Primary mixed with background/foreground | Badges, soft highlights, pricing cards |
| `--brand-outline` | Primary outline tint | Focused/selected outlines |
| `--success`, `--warning`, `--info`, `--danger` | Semantic state HSL triples | Alerts, verification states, upload states |
| `--success-bg`, `--warning-bg`, `--info-bg`, `--danger-bg` | Alpha forms for soft backgrounds | Alert/card fills |
| `--status-working`, `--status-paused`, `--status-blocked`, `--status-idle`, `--status-completed` | Workflow indicators | Product screenshots or live-status components |

## Component Tokens

### Buttons

Use the app's newer button semantics instead of raw Tailwind color utilities:

| Token family | Intended role |
|---|---|
| `--button-prominent-*` | Filled primary CTAs |
| `--button-primary-*` | Soft primary buttons |
| `--button-tonal-*` | Secondary tonal buttons |
| `--button-outline-*` | Outline buttons |
| `--button-plain-*` | Icon/ghost buttons |
| `--button-destructive-*` | Destructive filled actions |
| `--button-danger-*` | Soft destructive actions |
| `--button-utility-*` | Neutral utility buttons |

Website mapping:

- Hero CTA: `--button-prominent-bg`, `--primary-foreground`.
- Secondary CTA: `--button-outline-bg`, `--button-outline-border`, `--text-primary`.
- Icon-only controls: `--button-plain-hover-bg`, `--button-radius`, `--button-icon-size`.

### Inputs and Menus

| Token family | Intended role |
|---|---|
| `--input-shell-surface`, `--input-shell-border`, `--input-shell-focus` | Inputs, search boxes, newsletter forms |
| `--menu-shell-surface`, `--menu-shell-border`, `--menu-shell-foreground`, `--menu-shell-row-hover`, `--menu-shell-row-active` | Dropdown menus, command menus, context menus |
| `--mobile-sheet-*` | Mobile bottom sheets |
| `--dialog-shell-*` | Dialog containers |
| `--composer-panel-*` | Chat composer panels; website should only reuse this for product demos |

## Geometry, Sizing, and Shadows

| Token | Value | Meaning |
|---|---:|---|
| `--radius` | `0.5rem` | shadcn base radius |
| `--radius-shell-panel` | `18px` | Large panels |
| `--radius-shell-toolbar` | `16px` | Toolbars/input shells |
| `--radius-shell-row` | `14px` | Rows/cards inside panels |
| `--radius-shell-control` | `12px` | Buttons, fields, chips |
| `--radius-shell-window-control` | `10px` | Window/chrome controls |
| `--radius-shell-dialog` | `22px` | Dialogs and mobile sheets |
| `--size-shell-control` | `32px` | Compact desktop controls |
| `--size-shell-window-control` | `34px` | Window controls |
| `--size-shell-touch-target` | `36px` | Small touch target |
| `--control-height-compact` | `32px` | Desktop compact height |
| `--control-height-touch` | `44px` | Mobile/touch height |
| `--touch-target-size` | `var(--control-height-touch)` | Shared accessible target |
| `--chat-thread-max-w` | `44rem` | App chat thread max width |

Shadow tokens are intentionally soft:

| Token | Meaning |
|---|---|
| `--shadow-shell-soft` | Small control/card shadow |
| `--shadow-shell-panel` | Main panel shadow |
| `--shadow-shell-floating` | Menus/popovers/dialogs |
| `--shadow-shell-pressed` | Pressed/active controls |
| `--shadow-content-subtle`, `--shadow-content-soft`, `--shadow-content-elevated` | Content-level elevation |

For the website, prefer fewer shadows than the app. Use borders and whitespace first; reserve `--shadow-shell-floating` for menus and overlays.

## Typography

Base variables:

| Token | Value |
|---|---|
| `--font-family` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"` |
| `--font-family-cn` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif` |
| `--app-font-family` | `"PingFang SC", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Microsoft YaHei", sans-serif` |
| `--font-mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |

Font sizes are compact and app-oriented:

| Token | Value at `--font-size-scale: 1` |
|---|---:|
| `--font-size-xs` | `11px` |
| `--font-size-sm` | `12px` |
| `--font-size-base` | `14px` |
| `--font-size-md` | `15px` |
| `--font-size-lg` | `16px` |
| `--font-size-xl` | `18px` |
| `--font-size-2xl` | `20px` |
| `--font-size-3xl` | `24px` |

For the official website, keep the same body stack and semantic text colors, but introduce a website display scale above the app scale for marketing/editorial pages. For example, define site-only tokens such as `--site-display-xl`, `--site-display-lg`, and `--site-section-title` rather than stretching the app's `--font-size-3xl`.

Typography rules:

- Body: `var(--font-family)`, `var(--font-size-base)`, line-height `1.5`.
- Chinese content: use `var(--font-family-cn)`.
- Headings: semibold, normal letter spacing, tight line height.
- Letter spacing should stay normal unless a specific brand lockup requires it.

## Motion and Native Feel

Interaction rules are defined in [src/styles/native-feel/interaction.css](../src/styles/native-feel/interaction.css):

- Focus rings use `2px solid hsl(var(--ring))`.
- Buttons do not scale on hover by default.
- Active buttons use a subtle `translateY(0.5px)` press.
- Common interaction transitions animate background, color, border, opacity, and shadow at `150ms ease`.
- Reduced motion disables these transitions.

Scrollbars are defined in [src/styles/native-feel/scrollbars.css](../src/styles/native-feel/scrollbars.css):

- Scrollbars are overlay-style and hidden until hover/focus.
- Thumb colors come from `--scrollbar-thumb` and `--scrollbar-thumb-hover`.
- Use `.scroll-always` only when persistent scroll affordance is necessary.

## Website Reuse Kit

For a lightweight official-site token base, copy these groups first:

1. Neutral HSL primitives from `shadcn-variables.css`.
2. Accent palette rules for `default`; optionally include all preset palettes if the website has theme personalization.
3. Semantic colors from `theme-colors.css`: `--surface-*`, `--interactive-*`, `--text-*`, `--border-*`, `--brand-*`, status tokens.
4. Geometry tokens: `--radius-*`, `--button-*` sizing, `--touch-target-size`.
5. Typography variables and base rules from `typography.css`.
6. Focus/transition rules from `native-feel/interaction.css`.

Minimal website CSS skeleton:

```css
:root {
  --radius: 0.5rem;
  --radius-shell-control: 12px;
  --radius-shell-row: 14px;
  --radius-shell-toolbar: 16px;
  --radius-shell-panel: 18px;

  --background: 0 0% 100%;
  --foreground: 220 9% 18%;
  --card: 0 0% 99%;
  --muted: 0 0% 94%;
  --muted-foreground: 220 6% 42%;
  --accent: 0 0% 93%;
  --border: 0 0% 88%;
  --primary: 215 72% 42%;
  --primary-foreground: 0 0% 100%;
  --ring: 214 62% 50%;

  --surface-root: hsl(var(--background));
  --surface-elevated: hsl(var(--card));
  --surface-muted: hsl(var(--muted));
  --text-primary: hsl(var(--foreground));
  --text-secondary: color-mix(in hsl, hsl(var(--foreground)) 70%, hsl(var(--muted-foreground)) 30%);
  --text-muted: hsl(var(--muted-foreground));
  --border-default: hsl(var(--border));
  --border-soft: color-mix(in hsl, hsl(var(--border)) 70%, transparent 30%);
  --interactive-hover: color-mix(in hsl, hsl(var(--foreground)) 10%, transparent 90%);
  --interactive-selected: color-mix(in hsl, hsl(var(--foreground)) 10%, transparent 90%);
}

:root.dark {
  --background: 0 0% 9%;
  --foreground: 0 0% 96%;
  --card: 0 0% 12%;
  --muted: 0 0% 14%;
  --muted-foreground: 0 0% 60%;
  --accent: 0 0% 15%;
  --border: 0 0% 18%;
  --primary: 214 64% 72%;
  --primary-foreground: 220 30% 10%;
  --ring: 214 58% 68%;
}
```

## What Not to Reuse Blindly

- Do not copy app-specific shell layout variables such as `--desktop-titlebar-height`, `--sidebar-width`, or `--shell-workspace-edge-radius` into marketing pages unless the page embeds an app-like shell.
- Do not use `--chat-*` tokens for general website sections. They are specifically tied to chat thread rendering.
- Do not use old hardcoded beige/study-ui colors. The current contract explicitly removed that warm tint from neutral surfaces.
- Do not make accent palettes recolor neutral surfaces. The palette contract treats accents as accents only.
- Do not reuse debug-panel hardcoded colors as brand colors; those are not part of the design system.

## Tailwind Mapping

The Tailwind config maps common utilities to tokens:

| Tailwind utility family | Token |
|---|---|
| `bg-background`, `text-foreground` | `--background`, `--foreground` |
| `bg-card`, `text-card-foreground` | `--card`, `--card-foreground` |
| `bg-primary`, `text-primary-foreground` | `--primary`, `--primary-foreground` |
| `bg-muted`, `text-muted-foreground` | `--muted`, `--muted-foreground` |
| `border-border`, `ring-ring` | `--border`, `--ring` |
| `rounded-shell`, `rounded-toolbar`, `rounded-row`, `rounded-control`, `rounded-dialog` | shell radius tokens |
| `shadow-shell`, `shadow-floating`, `shadow-pressed`, `shadow-soft` | shell shadow tokens |
| `max-w-thread` | `--chat-thread-max-w` |

For website code, prefer semantic CSS variables (`var(--surface-elevated)`, `var(--text-secondary)`) in authored CSS, and Tailwind token utilities in component markup.
