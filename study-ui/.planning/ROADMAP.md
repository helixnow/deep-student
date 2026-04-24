# Roadmap: study-ui Mobile Adaptation

**Created:** 2026-04-23
**Granularity:** Coarse
**Current milestone:** v1 Responsive Mobile/Tablet Adaptation

## Summary

| Phase | Name | Goal | Requirements | Status |
|-------|------|------|--------------|--------|
| 1 | Responsive Policy Foundation | Centralize responsive facts and layout decisions | RESP-01, RESP-02, RESP-03, RESP-04 | Complete |
| 2 | Root State And Layout Tokens | Expose policy state to CSS and split sidebar semantics | SHELL-01, SHELL-02, TOKN-01, TOKN-02 | Complete |
| 3 | Shell And Sidebar Adaptation | Make AppChrome/Titlebar/Sidebar work across compact and desktop modes | SHELL-03, SHELL-04, SHELL-05, SHELL-06 | Complete |
| 4 | Content Surface Adaptation | Make ThreadCanvas and SettingsPanel mobile/tablet-safe through tokens and responsive degradation | TOKN-03, THRD-01, THRD-02, THRD-03, THRD-04, THRD-05, SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-06 | Verified |
| 5 | Touch Targets And Verification | Lock controls, tests, build, and manual viewport acceptance | CTRL-01, CTRL-02, VERF-01, VERF-02, VERF-03, VERF-04, VERF-05 | Verified |
| 6 | Mobile Home Polish | Give phone empty state a ChatGPT-mobile-style landing while preserving tablet/desktop layouts | HOME-01, HOME-02, HOME-03, HOME-04, HOME-05 | Verified |
| 7 | DeepStudent Migration Foundation | Move the study-ui design contract into the parent DeepStudent app without a big-bang rewrite | MIGR-01, MIGR-02, MIGR-03, MIGR-04, MIGR-05, MIGR-06, MIGR-07, MIGR-08 | Implemented; Tauri UAT pending |
| 8 | DeepSeek Versioned Adapter Compatibility | Add version-aware DeepSeek configuration inside the shared DeepSeek adapter so V4, V3.2, official API, and SiliconFlow-hosted models each use the right settings | DSK-01, DSK-02, DSK-03, DSK-04, DSK-05, DSK-06, DSK-07, DSK-08 | Verified |

## Phase 1: Responsive Policy Foundation

**Goal:** Replace scattered viewport assumptions with a tested responsive environment and app layout policy.

**Status:** Verified

**UI hint:** yes

**Depends on:** None

**Requirements:** RESP-01, RESP-02, RESP-03, RESP-04

**Primary files:**

- `src/lib/responsive-env.ts`
- `src/lib/responsive-env.test.ts`
- `src/lib/app-layout-policy.ts`
- `src/lib/app-layout-policy.test.ts`
- `src/lib/app-shell.ts`
- `src/components/shell/AppChrome.tsx`

**Success criteria:**

1. A single module classifies `phone`, `tablet`, `desktop`, and `isCompact` using the agreed breakpoints.
2. A layout policy module derives sidebar mode, density, and form-factor decisions from environment state.
3. Tests cover `639`, `640`, `767`, `768`, `1023`, and `1024`.
4. `AppChrome` no longer owns a local `matchMedia("(max-width: 767px)")` policy.

## Phase 2: Root State And Layout Tokens

**Goal:** Make responsive state observable at the shell root and consumable by CSS tokens.

**Status:** Complete

**UI hint:** yes

**Depends on:** Phase 1

**Requirements:** SHELL-01, SHELL-02, TOKN-01, TOKN-02

**Primary files:**

- `src/App.tsx`
- `src/components/shell/AppChrome.tsx`
- `src/styles/app.css`
- `src/styles/app.source.test.ts`

**Success criteria:**

1. App state distinguishes mobile drawer visibility from desktop/sidebar collapsed state.
2. Shell root includes stable datasets for form factor, sidebar mode, density, and related policy state.
3. `app.css` defines reusable token names for gutters, widths, composer offset, safe-area-aware height, and touch target size.
4. Dataset-specific token overrides use the same token names rather than duplicated mobile/tablet token families.

## Phase 3: Shell And Sidebar Adaptation

**Goal:** Adapt AppChrome, Titlebar, and Sidebar while preserving desktop window behavior.

**Status:** Complete

**UI hint:** yes

**Depends on:** Phase 1, Phase 2

**Requirements:** SHELL-03, SHELL-04, SHELL-05, SHELL-06

**Primary files:**

- `src/components/shell/AppChrome.tsx`
- `src/components/shell/Titlebar.tsx`
- `src/components/shell/Sidebar.tsx`
- `src/components/shell/WindowControls.tsx`
- `src/components/shell/FramelessResizeHandles.tsx`
- `src/lib/app-shell.ts`

**Success criteria:**

1. Compact mode uses the existing `Sheet` sidebar rather than reserving desktop sidebar width.
2. Desktop mode keeps docked sidebar behavior and existing titlebar/window controls.
3. Compact navigation closes after selection where that improves mobile flow.
4. Mobile/tablet topbar keeps only core actions and does not inherit desktop-only status clutter.
5. Source tests protect desktop titlebar, window controls, and sidebar behavior from mobile regressions.

## Phase 4: Content Surface Adaptation

**Goal:** Make the main thread and settings surfaces readable, touch-friendly, and safe-area-aware across phone/tablet/desktop.

**Status:** Verified

**UI hint:** yes

**Depends on:** Phase 2, Phase 3

**Requirements:** TOKN-03, THRD-01, THRD-02, THRD-03, THRD-04, THRD-05, SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-06

**Primary files:**

- `src/components/content/ThreadCanvas.tsx`
- `src/components/content/ThreadCanvas.source.test.ts`
- `src/components/content/SettingsPanel.tsx`
- `src/components/content/SettingsPanel.source.test.ts`
- `src/components/ui/tabs.tsx`
- `src/components/ui/switch.tsx`
- `src/styles/app.css`

**Success criteria:**

1. Thread content and composer sizing consume layout tokens rather than page-local max-width/padding constants.
2. Composer uses safe-area-aware spacing and keeps input/send as the primary mobile interaction.
3. SettingsPanel stays one shared page while dense tables, tabs, and switch rows degrade cleanly under desktop widths.
4. Tests prevent reintroducing hard-coded desktop-only widths and confirm small-screen settings behavior.

## Phase 5: Touch Targets And Verification

**Goal:** Finish touch sizing, automated checks, and manual acceptance for the migration.

**Status:** Verified

**UI hint:** yes

**Depends on:** Phase 4

**Requirements:** CTRL-01, CTRL-02, VERF-01, VERF-02, VERF-03, VERF-04, VERF-05

**Primary files:**

- `src/components/shell/ShellButton.tsx`
- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/textarea.tsx`
- `src/components/ui/switch.tsx`
- `src/styles/app.css`
- Source/unit tests touched by earlier phases

**Success criteria:**

1. Phone/tablet controls meet the 44px hit target expectation while desktop can remain compact.
2. `npm run lint` passes.
3. `npm run build` passes.
4. Targeted source/unit tests pass for responsive policy, shell, ThreadCanvas, SettingsPanel, and app-shell behavior.
5. Manual viewport checks cover phone, tablet portrait, tablet landscape, desktop minimum, and wider desktop.

## Phase 6: Mobile Home Polish

**Goal:** Give the phone empty state a lightweight mobile landing inspired by the provided ChatGPT mobile reference, without adding upgrade/user growth entry points or changing tablet/desktop behavior.

**Status:** Verified

**UI hint:** yes

**Depends on:** Phase 5

**Requirements:** HOME-01, HOME-02, HOME-03, HOME-04, HOME-05

**Primary files:**

- `src/components/content/ThreadCanvas.tsx`
- `src/components/content/ThreadCanvas.source.test.ts`
- `src/components/shell/AppChrome.tsx`
- `src/components/shell/AppChrome.source.test.ts`

**Success criteria:**

1. Phone empty state uses concise centered copy and one suggestion CTA without the decorative prompt-card strip.
2. Phone composer becomes a floating single-line pill with 44px add/input/send controls and no recording icon.
3. Phone top-left chrome shows one edge-aligned 44px menu affordance without desktop title/update clutter.
4. Tablet and desktop retain the existing verified `ThreadCanvas` empty state and composer at `sm` and above.
5. No upgrade, user-plus, account-growth, or unrelated product entry points are introduced.

## Phase 7: DeepStudent Migration Foundation

**Goal:** Make the parent DeepStudent app consume study-ui as the design source of truth before migrating individual product surfaces.

**Status:** Implemented; Tauri UAT pending

**UI hint:** yes

**Depends on:** Phase 6

**Requirements:** MIGR-01, MIGR-02, MIGR-03, MIGR-04, MIGR-05, MIGR-06, MIGR-07, MIGR-08

**Primary files:**

- `src/styles/shadcn-variables.css`
- `src/styles/theme-colors.css`
- `src/components/ui/NotionButton.tsx`
- `src/components/ui/shad/Button.tsx`
- `src/components/ui/shad/Input.tsx`
- `src/components/ui/shad/Switch.tsx`
- `src/components/ui/shad/Sheet.tsx`
- `src/components/layout/MobileHeader.tsx`
- `src/components/layout/UnifiedMobileHeader.tsx`
- `src/components/layout/MobileSidebarNavigation.tsx`
- `src/components/ui/unified-sidebar/*`
- `study-ui/src/styles/app.css`
- `study-ui/src/components/ui/*`
- `study-ui/src/components/shell/*`

**Success criteria:**

1. Parent app tokens expose the study-ui surface, text, shell, button, input, focus, sidebar, and touch-target semantics with documented one-way sync from study-ui.
2. Parent app button/control primitives share the study-ui touch-density rule: phone/tablet stay at 44px targets until `lg` / `>=1024px`; desktop may remain compact.
3. Migrated shell, mobile header, sidebar drawer/sheet, and close controls use semantic tokens instead of local hard-coded palettes.
4. The migration allows existing pages to move gradually; no separate mobile-only design system or broad page rewrite is introduced.
5. Source tests or static checks prevent reintroducing hard-coded component colors, `md:` tablet shrink, and forbidden scale/spring motion in migrated primitives.

**Execution artifact:** `study-ui/.planning/phases/07-deepstudent-migration-foundation/07-01-SUMMARY.md`

**Residual verification:** Browser-only Vite smoke is blocked at `Loading...` because the parent app expects Tauri `invoke`/`listen` APIs; full root chat/settings/desktop chrome visual UAT should run in a Tauri dev/runtime session.

## Requirement Coverage

All v1 requirements from `.planning/REQUIREMENTS.md` are mapped to exactly one roadmap phase.

## Next Step

Phase 8 DeepSeek adapter compatibility is verified by targeted automated checks. Recommended next step: run Tauri runtime UAT for MIGR-08, then plan the first product-surface migration that consumes the shared primitive contract.

## Phase 8: DeepSeek Versioned Adapter Compatibility

**Goal:** Keep one shared `DeepSeekAdapter` for the DeepSeek model family, add version-aware configuration for V3.2 and V4, and let the hosting platform only choose the request field format required by official DeepSeek or SiliconFlow.

**Status:** Verified

**UI hint:** no

**Depends on:** Phase 7

**Requirements:** DSK-01, DSK-02, DSK-03, DSK-04, DSK-05, DSK-06, DSK-07, DSK-08

**Primary files:**

- `src-tauri/src/llm_manager/adapters/deepseek.rs`
- `src-tauri/src/llm_manager/builtin_vendors.rs`
- `src-tauri/src/reasoning_policy.rs`
- `src-tauri/src/providers/mod.rs`
- `src/utils/apiCapabilityEngine.ts`
- `src/utils/modelCapabilities.ts`
- `src/components/settings/ShadApiEditModal.tsx`
- `src/components/settings/modelConverters.ts`

**Success criteria:**

1. Official DeepSeek vendor presets and defaults move to `deepseek-v4-flash` / `deepseek-v4-pro`, while old `deepseek-chat` / `deepseek-reasoner` aliases remain compatibility-only and are not presented as the primary recommendation.
2. `DeepSeekAdapter` classifies DeepSeek model versions such as V3.2, V4, legacy aliases, and unknown future variants before applying request parameters.
3. Official DeepSeek V4 requests support V4 request semantics, including `thinking.type` and `reasoning_effort`, while SiliconFlow-hosted DeepSeek models keep using the SiliconFlow request field format such as `enable_thinking` / `thinking_budget`.
4. SiliconFlow-hosted `deepseek-ai/DeepSeek-V3.2` continues to work unchanged, and SiliconFlow-hosted DeepSeek V4 model IDs reuse the same DeepSeek adapter with V4 model defaults and SiliconFlow request formatting.
5. Capability inference, default parameters, and context window heuristics distinguish DeepSeek model versions instead of flattening all DeepSeek models into one V3.x-era rule set.
6. DeepSeek settings UI reflects the correct capability model: model support is separate from per-request thinking toggles, and V4-capable configs can expose effort controls without misclassifying SiliconFlow V3.2.
7. Streaming reasoning capture and tool-loop reasoning passback continue to work for DeepSeek V4 and remain backward compatible with existing DeepSeek-style `reasoning_content` flows.
8. Regression coverage includes at least: official DeepSeek V4 no-tools, official DeepSeek V4 with tools, SiliconFlow DeepSeek V3.2, and a SiliconFlow DeepSeek V4-shaped model identifier.
9. Planning and implementation keep one DeepSeek family adapter; version-aware model configuration and platform-specific request formatting live inside shared adapter/capability layers instead of duplicated UI/model pipelines.

**Plans:** 1 plan

Plans:
- [x] 08-01 Versioned DeepSeek Adapter Compatibility
