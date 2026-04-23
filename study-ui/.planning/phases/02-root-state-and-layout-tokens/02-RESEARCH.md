# Phase 2: Root State And Layout Tokens - Research

## RESEARCH COMPLETE

**Phase goal:** Make responsive state observable at the shell root and consumable by CSS tokens.

**Requirement IDs:** SHELL-01, SHELL-02, TOKN-01, TOKN-02

## What Matters For Planning

Phase 2 should build directly on Phase 1's `ResponsiveEnvironment` and `AppLayoutPolicy`. The main goal is structural clarity rather than a visible redesign:

1. `App.tsx` should stop using one `isSidebarOpen` state for multiple concepts.
2. `AppChrome` should expose policy state through root datasets.
3. `app.css` should define reusable layout token names that later content phases can consume.

## Recommended Technical Shape

### `src/App.tsx`

Replace:

- `isSidebarOpen`
- `setIsSidebarOpen`
- `toggleSidebar`

With separate state:

- `mobileSidebarOpen`
- `sidebarCollapsed`
- `toggleMobileSidebar`
- `toggleSidebarCollapsed`

`AppChrome` can receive both state values and both toggles. It already knows the active `sidebarMode`, so it can route sidebar toggles correctly.

### `src/components/shell/AppChrome.tsx`

Expose policy datasets on the shell root:

- `data-form-factor={layoutPolicy.formFactor}`
- `data-sidebar-mode={layoutPolicy.sidebarMode}`
- `data-density={layoutPolicy.density}`
- `data-shell-mode={layoutPolicy.shellMode}`
- `data-compact={layoutPolicy.isCompact ? "true" : "false"}`

Also expose sidebar state hints that CSS and future tests can consume:

- `data-sidebar-visible`
- `data-sidebar-collapsed`

Keep the existing Sheet/docked branches. Phase 2 should not make mobile nav close-on-select or tablet rail behavior.

### `src/styles/app.css`

Extend the existing token layer with shared names:

- `--page-gutter-inline`
- `--page-gutter-block`
- `--sidebar-width`
- `--sidebar-mode`
- `--workspace-max-width`
- `--composer-max-width`
- `--composer-bottom-offset`
- `--layout-safe-area-top/right/bottom/left`
- `--layout-viewport-height`
- `--touch-target-size`

Override these same names in dataset selectors such as `[data-form-factor="phone"]`, `[data-form-factor="tablet"]`, `[data-form-factor="desktop"]`, `[data-sidebar-mode="drawer"]`, `[data-sidebar-mode="docked"]`, and `[data-density="touch"]`.

## Validation Architecture

Add source-level tests because this phase is mostly policy wiring and token contract:

- `src/App.source.test.ts` locks the split state names and ensures `isSidebarOpen` is not reintroduced.
- `src/components/shell/AppChrome.source.test.ts` locks root datasets and routed toggle behavior.
- `src/styles/app.source.test.ts` locks token names and dataset overrides.

Recommended commands:

```bash
node --test --experimental-strip-types src/App.source.test.ts src/components/shell/AppChrome.source.test.ts src/styles/app.source.test.ts src/lib/responsive-env.test.ts src/lib/app-layout-policy.test.ts
npm run lint
npm run build
```

## Risks

- Accidentally changing sidebar visibility semantics would regress desktop titlebar/sidebar behavior. Keep `shouldPinSidebarOpen` in `AppChrome`.
- Dataset tokens should be scoped to the shell root, not assumed globally on `html`.
- Token additions should not force `ThreadCanvas` or `SettingsPanel` consumption in this phase.

## Out Of Scope For Phase 2

- Sidebar auto-close after navigation.
- Tablet rail mode.
- ThreadCanvas width/padding rewrite.
- SettingsPanel card/table degradation.

