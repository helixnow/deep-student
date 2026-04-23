# Phase 1: Responsive Policy Foundation - Research

## RESEARCH COMPLETE

**Phase goal:** Replace scattered viewport assumptions with a tested responsive environment and app layout policy.

**Requirement IDs:** RESP-01, RESP-02, RESP-03, RESP-04

## What Matters For Planning

Phase 1 is a policy foundation, not a visual redesign. The implementation should introduce two small TypeScript modules and wire `AppChrome` to consume them without changing the visible shell behavior.

The current risk is concentrated in `src/components/shell/AppChrome.tsx`, where compact behavior is owned by:

- `compactViewportQuery`
- `window.matchMedia("(max-width: 767px)")`
- `subscribeCompactViewport`
- `getCompactViewport`

That makes tablet behavior ambiguous and hides policy inside the shell component.

## Recommended Technical Shape

### `src/lib/responsive-env.ts`

Own viewport and input facts.

Recommended exports:

- `RESPONSIVE_BREAKPOINTS`
- `FormFactor`
- `InputMode`
- `ShellMode`
- `ResponsiveEnvironment`
- `getFormFactor(width: number)`
- `isCompactWidth(width: number)`
- `createResponsiveEnvironment(input)`
- `getBrowserResponsiveEnvironment()`
- `getServerResponsiveEnvironment()`
- `subscribeResponsiveEnvironment(listener)`

The browser snapshot can use `window.innerWidth` and pointer media queries. The server snapshot should return desktop-safe defaults so SSR/test snapshots do not crash.

### `src/lib/app-layout-policy.ts`

Own app layout decisions derived from responsive facts.

Recommended exports:

- `SidebarMode = "drawer" | "docked"`
- `Density = "touch" | "desktop"`
- `AppLayoutPolicy`
- `getAppLayoutPolicy(environment)`

Initial policy:

- `sidebarMode = environment.isCompact ? "drawer" : "docked"`
- `density = environment.isCompact || environment.inputMode === "coarse" ? "touch" : "desktop"`

Do not implement tablet rail in Phase 1. Leave room for `"rail"` later if needed.

## Existing Patterns To Reuse

- `src/lib/app-shell.ts` already uses pure helper functions and exported string-union types; follow that style for policy helpers.
- `src/lib/app-shell.test.ts` uses Node's built-in `node:test` and direct imports from `.ts` files; use the same pattern for `responsive-env.test.ts` and `app-layout-policy.test.ts`.
- `src/components/shell/AppChrome.source.test.ts` uses source-contract assertions; update it to lock the new policy integration and prevent local breakpoint regressions.
- `AppChrome` already uses `useSyncExternalStore`; keep this pattern and move the subscription/snapshot helpers out of the component.

## Validation Architecture

Automated validation should prove four things:

1. Boundary math is correct at `639`, `640`, `767`, `768`, `1023`, and `1024`.
2. App layout policy maps phone/tablet to drawer/touch and desktop to docked/desktop.
3. `AppChrome` imports and consumes responsive policy helpers.
4. `AppChrome` no longer contains `matchMedia("(max-width: 767px)")`, `compactViewportQuery`, `subscribeCompactViewport`, or `getCompactViewport`.

Recommended command:

```bash
node --test --experimental-strip-types src/lib/responsive-env.test.ts src/lib/app-layout-policy.test.ts src/lib/app-shell.test.ts src/components/shell/AppChrome.source.test.ts
```

Final project checks:

```bash
npm run lint
npm run build
```

## Risks

- Source tests are exact-string oriented and may need targeted updates when `AppChrome` changes.
- The current `AppChrome` compact branch uses `Sheet` and desktop branch uses docked sidebar. Phase 1 should keep that behavior and only change where the decision comes from.
- Adding too many token or visual decisions here would steal scope from Phase 2 and Phase 3.

## Out Of Scope For Phase 1

- Splitting `App.tsx` sidebar state.
- Adding root `data-form-factor` or CSS token overrides.
- Implementing tablet rail.
- Reworking ThreadCanvas, SettingsPanel, or touch target sizes.
