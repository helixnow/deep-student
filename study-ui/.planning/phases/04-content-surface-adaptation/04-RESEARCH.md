# Phase 4: Content Surface Adaptation - Research

**Researched:** 2026-04-23
**Mode:** Manual fallback, codebase-local research
**Inputs:** `04-CONTEXT.md`, `04-UI-SPEC.md`, current source files, existing source tests

## Findings

### Token Foundation Is Already Available

`src/styles/app.css` already defines the tokens Phase 4 needs:

- `--page-gutter-inline`
- `--page-gutter-block`
- `--workspace-max-width`
- `--composer-max-width`
- `--composer-min-height`
- `--composer-bottom-offset`
- `--layout-safe-area-top`
- `--layout-safe-area-right`
- `--layout-safe-area-bottom`
- `--layout-safe-area-left`
- `--touch-target-size`

Phone, tablet, desktop, sidebar mode, and density datasets already override these names. Phase 4 should consume the existing token contract instead of adding `--mobile-*` or `--tablet-*` variants.

### ThreadCanvas Is Structurally Good But Still Desktop-Width Driven

`ThreadCanvas.tsx` already has the correct high-level structure:

- One flex column.
- One scrollable content region.
- One bottom composer.
- One calm empty state.
- One persistent send button.

The responsive gap is local sizing:

- The scroll region uses `px-4 pb-6 pt-3 md:px-8 md:pb-8 md:pt-4`.
- The content wrapper uses `max-w-[44rem]`.
- The composer footer uses `px-4 pb-3 pt-2.5 md:px-8 md:pb-4`.
- The composer wrapper uses `max-w-[44rem]`.
- Source tests currently assert these desktop values instead of preventing them.

The simplest correct implementation is to keep the component shape and move outer content/composer geometry into inline style objects backed by CSS variables. Tailwind arbitrary class names are acceptable, but style objects make safe-area calc strings easier to test and less brittle.

### Composer Needs Input-First Compact Rhythm

The current composer already separates the textarea, secondary actions, and send button. On compact widths the secondary action cluster can wrap next to the send button and compete with the primary path.

Recommended compact structure:

- Keep textarea full width and token-height driven.
- Keep send button persistent and outside any horizontal-scroll group.
- Put attachment/model/reasoning controls in a `min-w-0 flex-1 overflow-x-auto` or wrapping secondary region.
- Keep the control copy short; do not add a hidden menu in Phase 4.
- Use `--composer-bottom-offset` for footer bottom spacing and include left/right safe-area math.

### SettingsPanel Has Good Local Building Blocks

`SettingsPanel.tsx` already centralizes most repeated layout through:

- `SettingsSection`
- `SettingBlock`
- `SettingsRow`
- shared settings control class constants
- local data/card helpers

This supports a shared-page adaptation. No separate mobile settings page is needed.

Current responsive risks:

- Content wrapper uses `max-w-[46rem]`.
- AppChrome settings scroll wrapper still owns desktop-only `px-6 pb-10 md:px-20`.
- Language/theme tabs are compact visually but not full-width/equal-width on phone.
- Switch controls are wrapped visually, but the larger row/label area is not the target.
- Embedding dimension data renders as a six-column pseudo-table with no compact labeled fallback.
- Preview dialogs use `w-[min(92vw,52rem)]` and `w-[min(92vw,48rem)]`, which is acceptable as a width cap but not enough for safe vertical viewport behavior or compact padding.

### Minimal Shell Touchpoint Is AppChrome Settings Scroll

`SettingsPanel` does not own the scroll container. `AppChrome.tsx` wraps settings content with:

```tsx
className="custom-scrollbar box-border flex-1 overflow-y-auto px-6 pb-10 md:px-20"
style={{ paddingBottom: settingsScrollPaddingBottom, paddingTop: settingsScrollPaddingTop }}
```

To satisfy `SETT-05`, Phase 4 should minimally token-drive the settings scroll container's inline gutters while preserving the top/bottom drag/safe-area behavior and all shell/sidebar/titlebar contracts.

### Source Tests Are The Right Verification Layer

The project uses source tests to lock structural UI contracts. Phase 4 should update these tests before or alongside component changes:

- `ThreadCanvas.source.test.ts` should assert token and safe-area usage and reject old hard-coded widths/gutters.
- `SettingsPanel.source.test.ts` should assert one shared page, token content width, dense fallback cards/definition lists, equal-width compact tabs, and switch row contracts.
- `AppChrome.source.test.ts` should assert tokenized settings scroll gutters if AppChrome is touched.
- `app.source.test.ts` should remain unchanged unless new shared tokens are added. Current research indicates no new tokens are required.

## Recommended Implementation

1. Tokenize `ThreadCanvas` outer content and composer footer using existing layout tokens and safe-area aliases.
2. Update composer action layout so compact widths keep textarea and send as the primary path while secondary controls wrap or scroll without displacing send.
3. Tokenize `SettingsPanel` content max width and AppChrome settings scroll inline gutters.
4. Add a local `SettingsSwitchRow` helper in `SettingsPanel` for switch rows. Preserve Radix `Switch` and use row/label-level interaction locally.
5. Replace the compact embedding dimensions pseudo-table with labeled compact cards/definition lists while keeping the desktop six-column table at `lg` and above.
6. Make short settings tabs full-width/equal-width on compact screens, returning to intrinsic width on desktop.
7. Make settings preview dialogs viewport-safe with responsive padding and max-height/overflow behavior.
8. Run targeted source tests, lint, and build.

## Risks

- Full mobile keyboard behavior cannot be proven by source tests. Phase 4 should improve safe-area spacing and leave real WebView keyboard validation to Phase 5.
- Wrapping `Switch` inside an interactive row can create nested-control accessibility issues. Prefer a row with a separate `label htmlFor={switchId}` area and a sibling `Switch` rather than nesting a button inside a clickable button.
- Desktop scan density could regress if the six-column embedding table is removed entirely. Keep it for `lg` and above.
- AppChrome edits should be limited to the settings scroll container. Shell/sidebar/titlebar behavior is Phase 3 territory and should remain unchanged.

---
*Phase: 04-content-surface-adaptation*
*Research completed: 2026-04-23*
