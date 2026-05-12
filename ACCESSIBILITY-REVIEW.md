# Deep Student — Accessibility Review

**Audited:** 2026-05-11
**Baseline:** WCAG 2.2 Level AA (POUR four principles, 50 Level-A/AA success criteria)
**Method:** Code-only audit across both UI trees (`src/` legacy + `study-ui/` new shell). No assistive-tech end-to-end run, no browser contrast measurement — findings noted where manual verification is recommended.
**Scope excluded:** Tauri native menus, installer flow, marketing site.

---

## Pillar Scores

POUR principles adapted to WCAG 2.2 AA surface areas.

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| P1. Perceivable — color & contrast | 1/4 | Primary/warning/info/destructive tokens fail 4.5:1 against their `-foreground`; borders at 1.4:1 fail 1.4.11; 100+ status chips use raw Tailwind color classes (`bg-red-100`, `text-green-800`) that bypass semantic tokens |
| P2. Perceivable — text & media | 2/4 | Skip link + 12 aria-live regions in legacy shell are solid; but 425 raw-px font sizes ignore user scaling, markdown tables have no `<th scope>`, 6 `<img>` alts are meaningless ("image-N" fallback) |
| P3. Operable — keyboard & focus | 2/4 | Radix dialogs/menus cover the majority; 25 `onClick`-on-div offenders, 5 custom modals without focus trap, drag-reorder in notes/mindmap has no keyboard fallback (2.5.7) |
| P4. Operable — time & motion | 1/4 | Only 1 CSS file respects `prefers-reduced-motion` out of 413 animated files; 22 Framer Motion components have zero `useReducedMotion` gates; toasts auto-dismiss all severities (2.2.1) |
| P5. Understandable — language & errors | 1/4 | `<html lang>` hardcoded in 2 entry HTMLs, never updated on locale switch; 0/8 production forms wire `aria-invalid` + `aria-describedby`; 15+ "Unknown error" strings ship to users; 6 destructive actions still use `window.confirm` |
| P6. Robust — semantics & ARIA | 2/4 | 38+ hand-rolled `role="button"` / `role="dialog"` / `role="tablist"` without full ARIA pattern; `study-ui` shell lacks skip link and h1 at `<sm`; nested `<main>` in 3 views; two nested `<header>` banners when Titlebar mounts inside AppChrome |

**Overall: 9/24**

Comparison: UI-REVIEW.md scored 11/24. The a11y gap is real but concentrated — fixing the top 5 issues below lifts the score roughly 5 points.

---

## Top 5 Priority Fixes

1. **Reduced-motion is effectively unsupported across 413 animated files.** Only `src/chat-v2/styles/chat.css` guards on `prefers-reduced-motion`; the other 412 files with `transition-`, `animate-`, `@keyframes`, or Framer Motion run unconditionally. 22 files import `framer-motion` and zero call `useReducedMotion()`. Users with vestibular disorders, ADHD, or migraine see full dialog transitions, sidebar slides, streaming caret blinks, and `AnimatePresence` churn on every chat message. **Fix:** Add a global CSS escape hatch in `src/App.css` / `study-ui/src/styles/app.css`: `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; } }`. Then gate Framer Motion variants via `useReducedMotion()` in `ChatContainer.tsx`, `NotionDialog.tsx`, `LoadingScreen.tsx`, `ActivityTimeline`, `todoList`, `WorkflowTimeline`, and `SettingsCommon`. Expose a "Reduce motion" override in Settings for users whose OS flag is off but who still prefer less motion.

2. **Semantic color tokens fail contrast across both palettes.** In `src/styles/shadcn-variables.css`, `--primary` with white `--primary-foreground` yields ~3.9:1 light / ~2.2:1 dark; `--warning` 3.2:1; `--info` 4.2:1; paper-dark primary ~1.8:1; borders sit at 1.4:1 in both modes, failing 1.4.11 non-text contrast (3:1). study-ui oklch tokens degrade similarly (primary dark ≈2.3:1, `border` at alpha 0.08 ≈1.1:1). This cascades to every button, badge, input outline, and divider in the app. **Fix:** Re-derive tokens so every semantic pair meets 4.5:1 (text) and 3:1 (UI/borders). Start with primary (drop L ~6 units in light, raise in dark or flip foreground to `220 9% 12%`), then warning/info/destructive, then border (bump alpha or L delta). Add a Vitest contrast snapshot test that parses the CSS file and asserts ratios.

3. **Forms have zero programmatic error semantics.** `aria-invalid` appears in exactly 2 places, both in `study-ui` demo sections. Across 8 production forms (API-key editor, vendor key sections, MCP editor, MCP tools, crepe editor, mindmap save, translate workbench, chat input), none wire `aria-invalid`, none link `aria-describedby` to an error message, none move focus to the first invalid field. The app also emits 15+ "Unknown error" / "Failed to …" strings verbatim to users with no suggested action. **Fix:** Standardize a `<FormField>` wrapper that owns validation state, renders `<p id="…-err" role="alert">` when invalid, and sets `aria-invalid` + `aria-describedby` on the control. Retrofit `ShadApiEditModal.tsx`, `VendorApiKeySection.tsx`, `McpEditorSection.tsx`, `McpToolsSection.tsx`, and `TranslateWorkbench.tsx` first. Replace generic fallbacks (e.g. `useEssayGradingStream.ts:263`, `useTranslationStream.ts:213`, `App.tsx:968`, `main.tsx:227`) with i18n keys that include recovery guidance.

4. **`<html lang>` never updates and the new shell has no skip link or h1.** `index.html` hardcodes `lang="en"`; `study-ui/index.html` hardcodes `lang="zh-CN"`; `src/i18n.ts` fires `languageChanged` but never writes `document.documentElement.lang`. Screen readers pronounce code with the wrong accent. Meanwhile `study-ui/src/components/shell/AppChrome.tsx:495` renders `<main>` without an `id`, has no skip link at all, and its `<h1>` at line 524 is `hidden sm:block` — phone viewports have no page title. **Fix:** In `src/i18n.ts`, inside both `languageChanged` handlers: `document.documentElement.lang = normalizeSupportedLanguage(lng)`. In AppChrome, add `id="main-content"`, render a `sr-only` skip link above the header matching `src/App.tsx:2184`, and either show a compact `<h1>` at phone breakpoints or mark it `sr-only`.

5. **Duplicate destructive-action patterns: 6 native `window.confirm` sites vs. the styled `NotionAlertDialog`.** `MessageItem.tsx` retry, `TranslateWorkbench.tsx` clear, `MindMapContentView.tsx` unsaved warning, `McpToolsSection.tsx`, `OcrEngineCard.tsx`, `DataGovernanceDashboard.tsx` all use `window.confirm`, which blocks the event loop, cannot be styled, returns focus inconsistently on Tauri/Linux, and violates 3.2.4 (consistent identification) since `LearningHubSidebar.tsx` already uses `NotionAlertDialog` for the same class of action. **Fix:** Migrate all 6 sites to `NotionAlertDialog` (or the Radix AlertDialog). While migrating, also apply the auto-dismiss policy fix: `UnifiedNotification` currently auto-dismisses even assertive/error toasts after 6–15s (2.2.1). Disable auto-dismiss when `isAssertive === true`.

---

## WCAG 2.2 AA Scorecard

P = pass. F = fail (see findings). P? = likely pass but not verified with AT.

| SC | Title | Status | Evidence |
|----|-------|--------|----------|
| 1.1.1 | Non-text Content | F (minor) | 6 low-quality alts incl. `image-${citationIndex}` in MarkdownRenderer:200 |
| 1.3.1 | Info and Relationships | F | Nested `<main>` in TemplateManager/DataCenter/SOTADashboardLite; markdown tables no `<th scope>`; `<aside role="navigation">` conflicts |
| 1.3.2 | Meaningful Sequence | P? | Not independently verified |
| 1.3.3 | Sensory Characteristics | P | — |
| 1.3.4 | Orientation | P | Desktop app, no orientation lock |
| 1.3.5 | Identify Input Purpose | F (minor) | `autocomplete` attributes not audited on API-key / auth inputs |
| 1.4.1 | Use of Color | F | QuestionHistoryView correct/incorrect badges color-only; WorkspaceMessageItem tag hues |
| 1.4.3 | Contrast (Minimum) | F | See Top-5 #2; primary/warning/info/destructive tokens fail |
| 1.4.4 | Resize Text 200% | F | 425 raw-px font-size declarations; `text-[11px]` in 24 TSX files |
| 1.4.5 | Images of Text | P? | No obvious text-in-image |
| 1.4.10 | Reflow | F | No <640px media queries; chat canvas 2-axis scroll at 400% zoom |
| 1.4.11 | Non-text Contrast | F | Border token 1.4:1 in both modes; checkbox border `border-border/40` |
| 1.4.12 | Text Spacing | F (likely) | Fixed `max-height` on ThinkingChain and badges clip |
| 1.4.13 | Content on Hover/Focus | F (partial) | Radix tooltip good; 13 hand-rolled `onMouseEnter` reveals not audited for dismissable/persistent |
| 2.1.1 | Keyboard | F | 25 onClick-on-div; FieldTypeConfigurator, RealTimeTemplateEditor disclosures mouse-only |
| 2.1.2 | No Keyboard Trap | P | Radix covers modals; custom modals don't trap but also don't trap *out* |
| 2.1.4 | Character Key Shortcuts | P | All global shortcuts modifier-gated |
| 2.2.1 | Timing Adjustable | F | UnifiedNotification auto-dismisses error/warning in 6–15s |
| 2.2.2 | Pause, Stop, Hide | F | LoadingScreen setInterval loops; chat streaming auto-scroll has no pause |
| 2.3.1 | Three Flashes | P | No >3Hz content |
| 2.3.3 | Animation from Interaction | F | 412/413 files bypass `prefers-reduced-motion` |
| 2.4.1 | Bypass Blocks | F | study-ui has no skip link; legacy shell OK |
| 2.4.2 | Page Titled | P? | Tauri window title set; per-route `<title>` not audited |
| 2.4.3 | Focus Order | P? | No clear violations found |
| 2.4.4 | Link Purpose (in Context) | P? | — |
| 2.4.5 | Multiple Ways | N/A | Single-page app |
| 2.4.6 | Headings and Labels | F | Most chat/review routes have no h1; study-ui h1 hidden <sm |
| 2.4.7 | Focus Visible | F (partial) | 40 files remove outline without paired `focus-visible` replacement |
| 2.4.11 | Focus Not Obscured (Min) | P? | Not measured; sticky toolbars in chat panels suspect |
| 2.5.1 | Pointer Gestures | P? | — |
| 2.5.2 | Pointer Cancellation | P | — |
| 2.5.3 | Label in Name | P? | — |
| 2.5.4 | Motion Actuation | N/A | — |
| 2.5.7 | Dragging Movements (2.2 new) | F | Notes tree, mindmap, attachment chips drag-only |
| 2.5.8 | Target Size (Minimum, 2.2 new) | P? | `study-ui` shell ≥28×40; legacy not exhaustively measured |
| 3.1.1 | Language of Page | F | `<html lang>` never updated on locale switch |
| 3.1.2 | Language of Parts | F | Mixed CN/EN strings without `lang=` wrappers in EditRetryDebugPlugin, LearningHubSidebar |
| 3.2.1 | On Focus | P (minor) | 4 focus-triggered expansions (DstuAppLauncher, FinderQuickAccess, pdf viewer, TodoMainPanel) — low risk |
| 3.2.2 | On Input | P? | No implicit form submits found |
| 3.2.3 | Consistent Navigation | P | — |
| 3.2.4 | Consistent Identification | F | NotionAlertDialog vs window.confirm for same action class |
| 3.2.6 | Consistent Help (2.2 new) | P? | Help surface not audited |
| 3.3.1 | Error Identification | F | 0/8 forms programmatically identify errors |
| 3.3.2 | Labels or Instructions | P (partial) | Legacy settings OK; auth/provider sub-sections not fully audited |
| 3.3.3 | Error Suggestion | F | 15+ "Unknown error"; error strings rarely include remediation |
| 3.3.4 | Error Prevention (Financial, Legal, Data) | F | 6 destructive actions use `window.confirm`; note/paper delete is easy-to-hit |
| 3.3.7 | Redundant Entry (2.2 new) | P | Local-first, no multi-step re-entry |
| 3.3.8 | Accessible Authentication (2.2 new) | P | API-key fields support paste; no CAPTCHA |
| 4.1.2 | Name, Role, Value | F | 38+ hand-rolled role="…" (button/dialog/tablist/listbox/switch/menu) incomplete |
| 4.1.3 | Status Messages | F (partial) | 12 aria-live regions exist; maintenance banner, form errors missing |

**Pass: 19** · **Partial/unverified: 10** · **Fail: 21**

---

## Detailed Findings by Pillar

### P1. Perceivable — Color & Contrast (1/4)

**P0 — Semantic token contrast failures (1.4.3 / 1.4.11):**

| Token (file:line) | Measured | Required | Where it bleeds |
|---|---|---|---|
| `--primary` × `--primary-foreground` light (`src/styles/shadcn-variables.css:170-181`) | ~3.9:1 | 4.5:1 | Primary buttons, tab pills, brand badges |
| `--primary` × `--primary-foreground` dark (`:184-186`) | ~2.2:1 | 4.5:1 | Same — unreadable in dark mode |
| `--destructive` × fg light (`:111-114`) | ~4.2:1 | 4.5:1 | Delete/danger buttons |
| `--warning` × fg light | ~3.2:1 | 4.5:1 | Warning chips, API test failures |
| `--info` × fg light | ~4.2:1 | 4.5:1 | Info banners |
| Paper-dark `--primary` (`:724-726`) | ~1.8:1 | 4.5:1 | Paper theme primary button label |
| `--border` × `--background` both themes (`:105, :144`) | ~1.4:1 | 3:1 | Every input, card, divider |
| study-ui `--primary` dark | ~2.3:1 | 4.5:1 | Confirm in browser (oklch) |
| study-ui `--border` alpha 0.08 | ~1.1:1 | 3:1 | All dividers in SettingsPanel |

**P0 — Color-only signals (1.4.1):**
- `src/components/QuestionHistoryView.tsx` — correct/incorrect badges differ only by `bg-green-100` / `bg-red-100`, no icon in compact row
- `src/chat-v2/workspace/components/WorkspaceMessageItem.tsx` — task/progress/result/query/correction/broadcast tags use hue only
- `src/components/UnifiedNotification.tsx:45-52` — `icon='auto'` omits icon for success/info, showing only tinted background

**P1 — Hardcoded colors bypass token system (1.4.3):** 1,857 hex values across 137 files. Top offenders: `App.css` 456, `study-ui/src/styles/app.css` 113, `RealTimeTemplateEditor.css` 67. Non-debug user-facing: `DeepStudent.css` 42, `BatchOperationToolbar/*.css` 95, `FieldTypeConfigurator.css` 33, `ThinkingChain.css` 29. About 200 raw Tailwind `bg-red-*`/`text-green-*` classes in TSX bypass semantics.

**P1 — Dark-mode component gaps:** UI-REVIEW flagged Settings, ModernSidebar, ChatV2Page, LearningHubSidebar. Also missing `dark:` variants in `VoiceInputControl`, `EssayEditorWrapper`, `ShortcutSettings`, `ApiConfigRecovery`, `SystemPromptEditor`, `AdvancedPanel`, `MultiSelectModelPanel`, `WorkspaceLogInline/Panel/AgentCard/AgentOutputDrawer/SubagentContainer`, `AnkiPanelHost`, `memory.tsx`, `anki/index.tsx`, `KnowledgeRadar`, `LearningTrendChart`, `LearningHeatmapChart`, `HeaderTemplate`. 30+ files total.

**P2 — No `prefers-contrast` / `prefers-color-scheme` honoring:** 0 CSS files. Theme is forced via `:root.dark` class only.

---

### P2. Perceivable — Text, Media, Structure (2/4)

**P0 — Text cannot scale to user preference (1.4.4):**
- `src/styles/typography.css`, `chat.css`, `chat-beautify.css`, `analysis.css`, `markdown.css`, `DeepStudent.css`, `App.css` contain 425 raw-px `font-size` declarations outside the `calc(11px * var(--font-size-scale))` token. Roughly 47% of type bypasses user scaling.
- 24 TSX files hardcode `text-[11px]` inline (e.g. `ConflictResolutionDialog.tsx`, `QuestionBankEditor.tsx`, `McpToolsSection.tsx`, `ReviewPlanView.tsx`).
- `study-ui` is mostly clean — honors `--app-font-scale` via rem.

**P0 — No reflow at 320px / 400% zoom (1.4.10):**
- 732 Tailwind responsive classes, but only 4 manual `@media (min-width …)` rules, all ≥768px
- No <640px column-collapse path; `src-tauri` window min is 980×680
- `ResizablePanelGroup`/SplitPane behavior at 400% zoom not tested

**P1 — Markdown tables without header semantics (1.3.1):**
- `src/chat-v2/components/renderers/MarkdownRenderer.tsx:612` — passthrough `<table>` without `<th scope="col">` or `<caption>`
- `src/chat-v2/plugins/blocks/components/ToolOutputView.tsx:129` — same

**P1 — Low-quality image alt text (1.1.1):**
- `MarkdownRenderer.tsx:200-208` — fallback `alt={\`image-${citationIndex}\`}` conveys no information to AT
- `InlineImageViewer.tsx:336,382`, `MessageAttachments.tsx:150`, `OcrResultCard.tsx:163`, `AttachmentPreviewChips.tsx:90`, `PageNavigator.tsx:268` — alt quality not verified

**P1 — Fixed `max-height` on text containers (1.4.12):** `ThinkingChain.css` and badge padding `px-1.5 py-0.5` clip when user text-spacing is enabled.

**P2 — Heading outline gaps (2.4.6):**
- Dashboard, ReviewPlanView, ReviewQuestionsView, ChatErrorBoundary — no h1
- `study-ui` AppChrome h1 `hidden sm:block` at phone widths
- Mobile settings: two h1s simultaneously when SystemSettingsSection renders inside UnifiedMobileHeader

---

### P3. Operable — Keyboard & Focus (2/4)

**P0 — Div+onClick offenders without keyboard equivalent (2.1.1):** 25 files in `src/`, 0 in `study-ui/`. Worst offenders:
- `src/components/mindmap/MindMapContentView.tsx` — shortcut-help modal backdrop, no Escape
- `src/components/DocumentViewer.tsx` — hand-rolled image modal
- `src/components/FieldTypeConfigurator.tsx` — disclosure header (`field-header`)
- `src/components/RealTimeTemplateEditor/index.tsx` — editor header disclosure
- `src/components/mindmap/components/mindmap/StructureSelector.tsx`, `toolbar/StylePanel.tsx` — popover triggers on bare divs
- `src/chat-v2/anki/index.tsx`, `src/chat-v2/plugins/blocks/components/RenderedAnkiCard.tsx` — entire card onClick
- `src/components/learning-hub/views/IndexStatusView.tsx` — custom modal backdrop

**P0 — Drag-only reordering (2.5.7 new):**
- `src/components/notes/DndFileTree/DndFileTree.tsx` + `TreeWithDndKit.tsx` — dnd-kit `KeyboardSensor` not registered
- `src/components/mindmap/components/mindmap/MindMapCanvas.tsx` — node drag only
- `src/chat-v2/components/input-bar/AttachmentPreviewChips.tsx`, `SortableGroupItem.tsx` — sortable chips mouse-only

**P1 — Custom modals without focus trap:**
- `DocumentViewer.tsx`, `MindMapContentView.tsx` (shortcut help), `IndexStatusView.tsx` (inspect panel), `BatchEditDialog.tsx`, `FilterBuilder.tsx` — none import `useFocusTrap` or use Radix Dialog
- `src/hooks/useFocusTrap.ts` exists but is only used by `ImageViewer.tsx`

**P1 — `outline-none` without paired `focus-visible` replacement (2.4.7):**
- 120 files remove outline; only 80 files declare `:focus-visible`; gap of ~40 needs individual verification
- Confirmed offenders: `InputBarUI.tsx` (6×), `McpDebugPlugin.tsx` (4×), `SessionBrowser.tsx` (4×), `command-palette.css` (1×), `MinimalTemplateEditor.css` (3×)

**P2 — Single-character hotkeys in focus-sensitive components:** `ImmersiveFocusMode.tsx`, `UserAgreementDialog.tsx`, `EnhancedPdfViewer.tsx` — verify they don't fire while an input is focused

---

### P4. Operable — Time & Motion (1/4)

**P0 — `prefers-reduced-motion` unsupported at scale (2.3.3):**
- Files with animations: ~413 (`transition-`, `animate-`, `@keyframes`, `animation:`)
- Files respecting the media query: **1** (`src/chat-v2/styles/chat.css`)
- Framer Motion importers: 22 (ChatContainer, LoadingScreen, NotionDialog, shad/Dialog, SettingsCommon, SkillFullscreenEditor, WorkflowTimeline, ActivityTimeline, todoList, WorkspaceLogInline, ExamSheetMobileLayout, motion-variants.ts, …)
- `useReducedMotion()` call sites: **0**
- Infinite CSS animations: ≥15 in `App.css` (typing, shimmer, loading-shine, pulse, thinking, blink) + `modern-buttons.css` + `notion-animations.css`

**P0 — Auto-dismissing error messages (2.2.1):**
- `src/components/UnifiedNotification.tsx` — `DURATION = Math.min(6000 + msg.length * 20, 15000)` applies to all severities. Error/warning toasts disappear before users with cognitive or motor disabilities can read them.

**P1 — Auto-scroll / streaming without pause control (2.2.2):**
- `UnifiedSourcePanel.tsx` — `scrollIntoView` twice
- `ModelMentionAutoComplete.tsx`, `ModelMentionPopover.tsx` — auto-scroll on arrow navigation
- `ParallelVariantView.tsx` — programmatic smooth scroll
- `ChatContainer.tsx` / `MessageList.tsx` — `AnimatePresence` on every message, auto-scrolls on stream
- Chat streaming has no user pause; debug-only plugins do

**P1 — Decorative setIntervals:** `LoadingScreen.tsx` runs two intervals (dots, steps) with no stop control

---

### P5. Understandable — Language, Input, Errors (1/4)

**P0 — Language attribute never updates (3.1.1):**
- `index.html:2` — `lang="en"` hardcoded
- `study-ui/index.html:2` — `lang="zh-CN"` hardcoded
- `src/i18n.ts` has two `i18n.on('languageChanged')` handlers, neither writes `document.documentElement.lang`
- `rg "documentElement.*lang"` → 0 hits

**P0 — Mixed-language content not marked (3.1.2):**
- `src/debug-panel/plugins/EditRetryDebugPlugin.tsx` — literal `'锁定'/'解锁'` next to English labels
- `src/components/learning-hub/LearningHubSidebar.tsx` — `t('contextMenu.confirmDelete', '确定要删除此资源吗？')` — CN fallback shipped in EN code path
- No `<span lang="zh-Hans">` / `<span lang="en">` wrappers anywhere

**P0 — No programmatic error identification (3.3.1 / 4.1.3):**
- `aria-invalid` occurrences: 2 (both study-ui demo sections, not live forms)
- Forms audited with 0 coverage: `ShadApiEditModal`, `VendorApiKeySection`, `McpEditorSection`, `McpToolsSection`, `TranslateWorkbench`, `CrepeEditor`, `MindMapContentView` save path, `InputBarUI`
- Focus-on-error: 0 occurrences

**P0 — Destructive actions on `window.confirm` (3.3.4 / 3.2.4):** 6 sites — `MessageItem.tsx`, `TranslateWorkbench.tsx`, `MindMapContentView.tsx`, `McpToolsSection.tsx`, `OcrEngineCard.tsx`, `DataGovernanceDashboard.tsx`. Inconsistent with `NotionAlertDialog` already used in `LearningHubSidebar.tsx`.

**P1 — Generic error messages (3.3.3):**
- ≥15 `"Unknown error"` strings: locales + runtime fallbacks in `useEssayGradingStream.ts:263`, `useTranslationStream.ts:213`, `App.tsx:968`, `main.tsx:227`
- Hundreds of `"Failed to …"` in locales with no remediation hint
- Only `ModernSidebar.tsx` uses `role="alert"` for inline error; other errors route through the disconnected global toast

**P2 — Focus-triggered context change (3.2.1, low severity):** `DstuAppLauncher`, `FinderQuickAccess`, `EnhancedPdfViewer`, `TodoMainPanel` all expand/replace UI on focus. No navigation/submit, so low risk.

---

### P6. Robust — Semantics & ARIA (2/4)

**P0 — Nested interactive elements (4.1.2):**
- `src/App.tsx:2242-2253`, `:2265-2286` — titlebar "hotzone" `<div role="button">` wraps real buttons (command palette trigger, new session). Buttons inside buttons.
- `src/components/ModernSidebar.tsx:866,892` — session row `<div role="button">` contains inner `<button>`s for pin/archive. 2–3 overlapping activators.

**P0 — Card-as-button antipattern (4.1.2):**
- `src/chat-v2/skills/components/SkillCard.tsx:85`, `src/components/skills-management/SkillsList.tsx:159,199` — entire card is `<div role="button">` wrapping `<h3>` + metadata + action buttons

**P0 — Hand-rolled dialog without full ARIA pattern (4.1.2):**
- `src/components/ui/NotionDialog.tsx:109,283` — `role="dialog"` / `role="alertdialog"` without confirmed `aria-modal`, `aria-labelledby`, focus-trap-on-open, focus-restore-on-close
- `src/command-palette/CommandPalette.tsx:257` — high-traffic; same gaps suspected
- `src/chat-v2/plugins/blocks/components/CitationPopover.tsx:118` — `role="dialog"` on a popover that likely isn't modal; should be `role="group"` or dropped

**P0 — study-ui shell missing skip link / `<main>` id (2.4.1):** `study-ui/src/components/shell/AppChrome.tsx:495` renders `<main>` bare, no skip link anywhere in the new shell. Keyboard users must tab through the sidebar each route.

**P1 — Landmark conflicts (1.3.1):**
- `src/components/ModernSidebar.tsx:1267-1269` — `<aside role="navigation">` overrides native complementary with navigation, conflicts with inner `<nav>`s
- `src/components/todo/TodoSidebar.tsx:189` — same
- `src/App.tsx:2201` + `study-ui/shell/Titlebar.tsx:62` — two nested `<header>` banners when Titlebar mounts inside AppChrome (banner inside banner)
- `TemplateManager.tsx:511`, `DataCenter.tsx:23`, `SOTADashboardLite.tsx:590` — nested `<main>` inside App.tsx's outer `<main>`

**P1 — Hand-rolled ARIA patterns (4.1.2):** 38+ sites. Categories:
- `role="button"` on div: 16 (incl. QuestionBankListView:163, SiliconFlowSection:935, ApisTab:283, ChatCollapsible:58, SourceCard:108, UnifiedSidebar:581, NoteTagsEditor:164, TabBar:183)
- `role="dialog"` hand-rolled: 4
- `role="tablist"`/`role="tab"` outside Radix: 3 (UnifiedSourcePanel:600,827, VariantSwitcher:146, BottomTabBar:83)
- `role="switch"` outside Radix: 5 (ChatParamsPanel, RagPanel, SettingsCommon, StyleDebugPage, AppMenu)
- `role="listbox"` hand-rolled: 4 (ModelMentionAutoComplete:220, ModelMentionPopover:146,183, FolderSelector:384)
- `role="menu"` hand-rolled: 5 (AppMenu:312/397/467/493, FolderTreeView:146, FolderTreeItem:140)

Each requires the full pattern (roving tabindex, arrow keys, `aria-selected`/`aria-checked`/`aria-expanded`, `aria-controls`). Radix primitives already in project; prefer migration over fixing.

**P1 — Missing live regions (4.1.3):**
- `src/App.tsx:2321-2345` — maintenance-mode banner, no `role="alert"` / `aria-live`
- `AttachmentValidationNotice.tsx`, `ConflictResolutionDialog.tsx` — inline errors without live region
- `study-ui` — no toast channel at all (0 aria-live regions in the new shell)

**P1 — Live region chatter risk:** `WorkflowTimeline.tsx:90` and `ChatAnkiProgressCompact.tsx:239` use `aria-live="polite"` on every stage tick — risk of overwhelming screen readers. Use diff-based updates.

**P2 — Correct patterns to preserve:**
- Skip link + `<main id>` in `src/App.tsx:2184, 2348`
- 12 aria-live regions (NotificationContainer, UnifiedNotification, MessageList ×3, ChatV2Page loading, InputBarUI status, ChatAnkiProgressCompact, WorkflowTimeline, PulseDot, shad/Alert)
- Radix-wrapped Dialog/DropdownMenu/Tooltip/Switch coverage
- Breadcrumb pattern in `ui/shad/Breadcrumb.tsx:13`

---

## Quick Reference — Files to Fix First

| File | Why | Effort |
|---|---|---|
| `src/styles/shadcn-variables.css` | Token contrast for every palette | M — requires color re-derivation + snapshot test |
| `src/App.css` (+ beautify/analysis/markdown/DeepStudent.css) | Global reduced-motion rule + stop infinite animations | S for escape hatch, M for per-rule audit |
| `src/i18n.ts` | `document.documentElement.lang` on locale change | XS |
| `index.html` + `study-ui/index.html` | Sync with i18n default | XS |
| `study-ui/src/components/shell/AppChrome.tsx` | `id="main-content"`, skip link, `sr-only` h1 at <sm | S |
| `src/components/UnifiedNotification.tsx` | Disable auto-dismiss when `isAssertive` | XS |
| `src/components/ui/NotionDialog.tsx` | Add `aria-modal`, `aria-labelledby`, focus trap — or swap to Radix Dialog | M |
| 6 `window.confirm` sites | Migrate to NotionAlertDialog | M |
| `src/chat-v2/components/renderers/MarkdownRenderer.tsx` + `ToolOutputView.tsx` | Table `<th scope>`; fix `alt="image-N"` fallback | S |
| New `<FormField>` wrapper + 5 forms | `aria-invalid` + `aria-describedby` + focus-on-error | L |
| `src/components/ModernSidebar.tsx` + `skills` cards | Remove nested interactive elements | M |

---

## Recommended Remediation Sequence

Phase A — foundations (≤1 week, highest value/cost ratio):

1. Global `prefers-reduced-motion` escape hatch in both CSS entry points
2. `document.documentElement.lang` wired to i18n
3. Skip link + `<main id>` + `sr-only` h1 in `study-ui` shell
4. `UnifiedNotification` no-auto-dismiss on assertive
5. Add `.eslintrc` rule blocking `role="button"` on non-button elements and `window.confirm`

Phase B — tokens & forms (≈2 weeks):

6. Re-derive color tokens to meet 4.5:1 / 3:1 (primary, destructive, warning, info, border, paper palette)
7. Add Vitest contrast snapshot test
8. `<FormField>` wrapper + retrofit 5 highest-traffic forms
9. Replace 6 `window.confirm` sites with `NotionAlertDialog`
10. Standardize error i18n keys with remediation guidance (drop "Unknown error")

Phase C — hand-rolled ARIA migration (≈2–3 weeks):

11. NotionDialog → Radix Dialog (or complete ARIA pattern)
12. Custom tablist/listbox/switch/menu → Radix equivalents where possible
13. Card-as-button refactor (ModernSidebar session rows, SkillCard)
14. `dnd-kit` KeyboardSensor + visible reorder commands for notes/mindmap/chips

Phase D — validation loop (ongoing):

15. Manual VoiceOver (macOS) + NVDA (Windows) pass per high-traffic route
16. Add axe-core to Playwright smoke tests
17. User research session with 2–3 disabled users before claiming compliance

---

## What This Audit Did NOT Cover

- Live assistive-technology walkthrough (VoiceOver, NVDA, JAWS, TalkBack)
- Browser-measured contrast (oklch values were approximated)
- Keyboard-only end-to-end flow test
- Screen magnifier / 400% zoom test
- Cognitive load user research
- Tauri native menus and native dialogs
- PDF viewer internal accessibility (pdfjs has its own a11y story)
- Anki card renderer output (user-authored content)

Full WCAG conformance requires those steps plus expert accessibility review.
