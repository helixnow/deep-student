# Phase 1: Responsive Policy Foundation - Patterns

## Closest Existing Analogs

### `src/lib/app-shell.ts`

Use as the style analog for small, pure policy helpers:

- Export string-union types such as `DesktopPlatform` and `TitlebarMode`.
- Export a constant token object with `as const`.
- Keep functions deterministic and easy to unit test.
- Avoid React imports in low-level library files.

### `src/lib/app-shell.test.ts`

Use as the unit test analog:

- Node built-in `node:test`.
- `assert.equal` and `assert.deepEqual` for boundary and object checks.
- Direct imports from `.ts` files.

### `src/components/shell/AppChrome.tsx`

Use as the integration target:

- It already imports `useSyncExternalStore`.
- It currently has the local compact viewport query that must move out.
- It should keep the existing `isCompactViewport` derived variable if that minimizes churn, but the value should come from layout policy.

### `src/components/shell/AppChrome.source.test.ts`

Use as the source-contract analog:

- Add assertions for the new imports.
- Add assertions that old local compact helpers are gone.
- Update the compact sheet assertion only as much as the implementation requires.

## Files To Create

- `src/lib/responsive-env.ts`
- `src/lib/responsive-env.test.ts`
- `src/lib/app-layout-policy.ts`
- `src/lib/app-layout-policy.test.ts`

## Files To Modify

- `src/components/shell/AppChrome.tsx`
- `src/components/shell/AppChrome.source.test.ts`

## Files To Verify

- `src/lib/app-shell.ts`
- `src/lib/app-shell.test.ts`

## Guardrails

- Do not add dependencies.
- Do not add CSS tokens in Phase 1.
- Do not change visible shell layout or motion.
- Do not move desktop titlebar/window behavior out of `app-shell.ts`.
- Do not add new `matchMedia` calls inside React components.
