# Phase 6 — UI Review

**Audited:** 2026-04-24
**Baseline:** `04-UI-SPEC.md` + `05-UI-SPEC.md` + Phase 6 summary/UAT
**Screenshots:** not captured (no dev server on `localhost:3000`, `5173`, `8080`, or `1422`)

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | Phase 6 phone copy is concise, focused, and free of generic CTA clutter. |
| 2. Visuals | 3/4 | Phone empty state hierarchy is clear, but the mobile settings sheet breaks the established shell language. |
| 3. Color | 2/4 | The semantic token foundation is strong, but `AppChrome` still ships a hardcoded mobile settings palette. |
| 4. Typography | 3/4 | Main surfaces stay restrained, but demo surfaces still contain display-sized arbitrary text. |
| 5. Spacing | 3/4 | Core thread/settings layout uses shared tokens, but several compact surfaces still rely on ad hoc px/rem values. |
| 6. Experience Design | 3/4 | Responsive behavior and UAT are strong, but the compact interaction contract is weakened by forbidden press-scale motion and limited state modeling. |

**Overall: 18/24**

---

## Top 3 Priority Fixes

1. **Retokenize the mobile settings sheet** — hardcoded `#FFFFFF`, `#111111`, `#EEF0F4`, `#0071E3`, and RGBA values in `study-ui/src/components/shell/AppChrome.tsx:382-473` break theme consistency and block reuse — move that surface onto existing semantic tokens or scoped aliases defined in `study-ui/src/styles/app.css`.
2. **Unify root-app button primitives around the study-ui contract** — the root app still splits across `NotionButton`, `ui/shad/Button`, and raw `<button>` usage, so touch sizing and button tone drift across surfaces — converge on one shared button API with `<1024` touch targets and shared tone tokens.
3. **Remove compact-surface scale/shadow exceptions** — `active:scale-[0.97]` and custom RGBA shadows in `study-ui/src/components/shell/AppChrome.tsx:421-449` and `study-ui/src/components/content/ThreadCanvas.tsx:92` violate the Phase 4/5 motion and color contract — replace them with tokenized background, border, and ring feedback.

---

## Detailed Findings

### Pillar 1: Copywriting (4/4)

- `study-ui/src/components/content/ThreadCanvas.tsx:64-72` keeps the phone landing copy tight and directive: one headline, one instruction, no decorative prompt strip, and no upgrade/account-growth detours.
- `study-ui/src/components/shell/AppChrome.tsx:317-320` and `study-ui/src/components/shell/AppChrome.tsx:431-454` keep compact navigation and sheet labeling explicit, with clear `aria-label` and section text.
- Grep across `study-ui/src` did not surface generic user-facing placeholders like `Submit`, `Click Here`, `OK`, `Cancel`, or `Save`; the matches were implementation identifiers rather than live UI text.

### Pillar 2: Visuals (3/4)

- `study-ui/src/components/content/ThreadCanvas.tsx:52-76` plus `study-ui/src/components/content/ThreadCanvas.tsx:90-115` establish a strong phone focal path: calm title block first, then the floating composer as the primary action target.
- `study-ui/src/components/shell/AppChrome.tsx:205-218` and `study-ui/src/components/shell/AppChrome.tsx:517-555` successfully simplify compact chrome to a single left affordance plus a single right action, which matches the Phase 6 intent.
- The main visual inconsistency is the mobile settings sheet in `study-ui/src/components/shell/AppChrome.tsx:382-473`. It introduces a different white/gray/blue visual language, custom handle styling, and iOS-like pressed motion that visually detaches from the quieter shell/content system used elsewhere.

### Pillar 3: Color (2/4)

- `study-ui/src/styles/app.css:4-115` provides a coherent semantic token layer for surfaces, shell regions, buttons, safe areas, and density-aware control sizing.
- Accent usage is generally controlled. `rg` found `16` `text-primary` / `bg-primary` / `border-primary` hits in `study-ui/src`, mostly on the send affordance, status pills, and selected states such as `study-ui/src/components/content/SettingsPanel.tsx:644`, `:673`, `:721`, `study-ui/src/components/content/ThreadCanvas.tsx:109`, and `study-ui/src/components/shell/SidebarUpdateBadge.tsx:12`.
- The main contract break is `study-ui/src/components/shell/AppChrome.tsx:382-473`, which hardcodes overlay, border, background, foreground, hover, and ring values instead of consuming the existing semantic palette.
- There are smaller leaks too: `study-ui/src/components/content/ThreadCanvas.tsx:92` uses a custom RGBA shadow for the phone composer, and `study-ui/src/components/content/SettingsPanel.tsx:1102` / `:1237` still use ad hoc inset RGBA shadows instead of named elevation tokens.

### Pillar 4: Typography (3/4)

- The core system stays within the intended restrained scale. `study-ui/src/components/ui/button.tsx:7-28`, `study-ui/src/components/content/ThreadCanvas.tsx:64-69`, and `study-ui/src/components/content/SettingsPanel.tsx:438-566` mainly use `xs/sm/base/lg/xl/2xl` and `font-medium` / `font-semibold`.
- There are no `text-3xl` or larger utility classes in `study-ui/src`, which keeps the product surfaces aligned with the stated typography ceiling.
- The main outlier is demo typography: `study-ui/src/components/content/settings-demo-sections.tsx:60` uses `text-[2rem]`, which is a display-sized arbitrary value outside the phase contract’s restrained UI rhythm.

### Pillar 5: Spacing (3/4)

- `study-ui/src/components/content/ThreadCanvas.tsx:14-34` correctly tokenizes thread width, composer width, safe-area gutters, and composer bottom offset through shared CSS variables.
- `study-ui/src/styles/app.css:73-87` and `study-ui/src/styles/app.css:118-159` centralize page gutter, workspace width, composer width, and touch target sizing by form factor and density.
- `study-ui/src/components/content/SettingsPanel.tsx:434-436` and `study-ui/src/components/content/SettingsPanel.tsx:463-479` show good componentized spacing discipline for content width and touch-safe rows.
- The remaining gaps are mostly one-off values: `study-ui/src/components/content/ThreadCanvas.tsx:56` and `:69` still use `max-w-[24rem]` / `max-w-[21rem]`; `study-ui/src/components/content/SettingsPanel.tsx:616` and `:1272` use ad hoc width values; `study-ui/src/components/shell/AppChrome.tsx:383-445` uses many local radius and spacing values instead of shell-level aliases.

### Pillar 6: Experience Design (3/4)

- `study-ui/.planning/phases/06-mobile-home-polish/06-UAT.md` shows all five Phase 6 checks passing on phone, tablet, and desktop viewports, which is solid evidence that the responsive split is working as intended.
- `study-ui/src/components/shell/AppChrome.tsx:287-295` exposes `data-form-factor`, `data-density`, `data-sidebar-mode`, and related state to CSS, which is exactly the right architecture for token-driven responsive behavior.
- `study-ui/src/components/ui/button.tsx:23-29` and `study-ui/src/components/shell/ShellButton.tsx:23-37` preserve the Phase 5 touch-target contract by keeping icon/small controls at `44px` below `lg`.
- `study-ui/src/components/shell/AppChrome.tsx:421` and `study-ui/src/components/shell/AppChrome.tsx:446` still use `active:scale-[0.97]`, which the interaction contract explicitly blocks.
- `study-ui` remains mostly a static demo surface set. The audit found no explicit loading states inside `study-ui/src`, and only one generic error catch in `study-ui/src/components/theme/theme-provider.tsx:151`, so state modeling is weaker than the responsive/UAT coverage.

---

## Componentization And Tokenization

- `study-ui` itself is well componentized in the areas that matter most for this phase. `study-ui/src/components/ui/button.tsx:7-28` feeds `study-ui/src/components/shell/ShellButton.tsx:23-37`, while `study-ui/src/components/content/SettingsPanel.tsx:438-566` breaks the settings surface into reusable row/section/block helpers instead of forking mobile-only pages.
- The root app has the token bridge in place. `src/App.tsx:47-48` imports `src/styles/shadcn-variables.css` and `src/styles/theme-colors.css`, and `src/styles/shadcn-variables.css:163-188` explicitly syncs root `--primary` and `--ring` values from study-ui.
- The root app does not yet have the same primitive convergence. Current counts in `src/` are `260` files importing `NotionButton`, `20` files importing `ui/shad/Button`, `1573` `NotionButton` usages, and `142` raw `<button>` occurrences. That is token landing without primitive unification.
- Touch sizing in the root app still misses the Phase 5 contract. `src/components/ui/NotionButton.tsx:61,66-78` allows tablet shrink via `md:min-h-9` and uses `h-7` / `h-8` / `h-9` / `h-8 w-8`; `src/components/ui/shad/Button.tsx:20-23,47-52` still permits 32-40px minimums instead of `44px` below `lg`.
- Iconography has not converged either. `study-ui` imports Phosphor exclusively (`9` imports, `0` Lucide imports), while the root app still carries `424` Lucide imports and only `8` Phosphor imports. `study-ui/components.json:20` also still says `"iconLibrary": "lucide"`, so the metadata has not caught up with the actual design direction.
- Net assessment: semantic token plumbing has landed in the root app at the stylesheet level, but the component layer is still early. In practice this means “colors are starting to align; primitives, icons, and responsive behavior are not aligned yet.”

---

Registry audit: `0` third-party blocks checked, no flags. `study-ui/components.json` exists, but the approved Phase 4/5 UI-SPEC registry tables only allow shadcn official blocks and list no third-party installs.

---

## Files Audited

- `study-ui/.planning/ROADMAP.md`
- `study-ui/.planning/phases/06-mobile-home-polish/06-01-SUMMARY.md`
- `study-ui/.planning/phases/06-mobile-home-polish/06-UAT.md`
- `study-ui/.planning/phases/04-content-surface-adaptation/04-UI-SPEC.md`
- `study-ui/.planning/phases/05-touch-targets-and-verification/05-UI-SPEC.md`
- `study-ui/AGENTS.md`
- `study-ui/components.json`
- `study-ui/src/styles/app.css`
- `study-ui/src/components/ui/button.tsx`
- `study-ui/src/components/shell/ShellButton.tsx`
- `study-ui/src/components/shell/AppChrome.tsx`
- `study-ui/src/components/content/ThreadCanvas.tsx`
- `study-ui/src/components/content/SettingsPanel.tsx`
- `study-ui/src/components/content/settings-demo-sections.tsx`
- `src/App.tsx`
- `src/styles/shadcn-variables.css`
- `src/styles/theme-colors.css`
- `src/components/ui/NotionButton.tsx`
- `src/components/ui/shad/Button.tsx`
- `src/components/layout/MobileSidebarNavigation.tsx`
