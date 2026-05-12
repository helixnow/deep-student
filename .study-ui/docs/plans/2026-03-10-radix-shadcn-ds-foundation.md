# Radix Shadcn DS Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current Kumo-first content primitives with a Radix Primitives + shadcn-style local wrapper + custom design-system foundation, while adding system-following dark mode with local persisted override.

**Architecture:** Keep the Tauri shell custom and authoritative. Rebuild the content primitive layer under `src/components/ui/` as local DS components backed by Radix primitives where interaction semantics matter, and semantic CSS variables where they do not. Theme state should be handled by a thin app-specific provider and a pre-hydration bootstrap script so light/dark/system resolution happens before React mounts and avoids theme flash.

**Tech Stack:** React 19, Vite 7, Tailwind CSS v4, Radix Primitives, shadcn-style local wrappers, Phosphor icons, `node:test` for pure theme logic.

---

## Why this direction

- `shadcn/ui`’s official docs treat dark mode as a first-class concern and organize components as local code you own, not a dependency black box. Official docs also document Tailwind v4 + React 19 support and encourage component ownership in-app.
- Radix’s official dark-mode guidance recommends class switching via a theme library because system-following theme resolution is easy to get subtly wrong around initial render and preference changes.
- For a Vite desktop app, the closest “SOTA” equivalent to `next-themes` is: an inline boot script in `index.html` + a lightweight `ThemeProvider` + `localStorage` override + `matchMedia` listener + semantic CSS variables consumed by DS wrappers.

Sources:
- [shadcn/ui dark mode](https://ui.shadcn.com/docs/dark-mode)
- [shadcn/ui Tailwind v4](https://ui.shadcn.com/docs/tailwind-v4)
- [Radix dark mode guidance](https://www.radix-ui.com/themes/docs/theme/dark-mode)

## Execution Status

- [x] Task 1: theme infrastructure
  - Evidence: added `src/lib/theme.ts` + `src/components/theme/theme-provider.tsx`; `node --test src/lib/theme.test.ts` passes; `curl http://127.0.0.1:1420` shows the pre-hydration theme script.
- [x] Task 2: local semantic tokens
  - Evidence: rewired `src/styles/app.css`, `src/lib/utils.ts`, and content/shell token usage; `node --test scripts/ds-token-contract.test.mjs` passes.
- [x] Task 3: Button + Card/Surface DS wrappers
  - Evidence: replaced `src/components/ui/button.tsx` and `src/components/ui/surface.tsx`, added `src/components/ui/card.tsx`, migrated current content panels; `node --test scripts/ds-primitives-contract.test.mjs` passes.
- [x] Task 4: Input + Switch
  - Evidence: added `src/components/ui/input.tsx`, rebuilt `src/components/ui/switch.tsx`, and exercised them in `src/components/content/SettingsPanel.tsx`; `node --test scripts/ds-primitives-contract.test.mjs` passes.
- [x] Task 5: Dialog + Tabs
  - Evidence: added `src/components/ui/dialog.tsx` and `src/components/ui/tabs.tsx`; exposed theme preference tabs + details dialog in `src/components/content/SettingsPanel.tsx`; `node --test scripts/ds-primitives-contract.test.mjs` passes.
- [x] Task 6: remove Kumo runtime path
  - Evidence: removed Kumo imports from `src/styles/app.css` and removed `@cloudflare/kumo`, `kumo-ui`, `@base-ui/react`, `lucide-react` from `package.json`; `node --test scripts/no-kumo-runtime.test.mjs` passes.

## Task 1: Add theme infrastructure first

**Files:**
- Create: `src/lib/theme.ts`
- Create: `src/lib/theme.test.ts`
- Create: `src/components/theme/theme-provider.tsx`
- Modify: `src/main.tsx`
- Modify: `index.html`
- Modify: `package.json`

**Step 1: Add the failing theme tests**

Write `src/lib/theme.test.ts` using `node:test` for:
- resolving effective theme from `"light" | "dark" | "system"`
- generating bootstrap-safe HTML dataset values
- reading/writing local override keys without DOM assumptions in pure helper functions

**Step 2: Run test to verify it fails**

Run: `node --test src/lib/theme.test.ts`
Expected: FAIL because `src/lib/theme.ts` does not exist yet.

**Step 3: Write minimal theme logic**

Implement `src/lib/theme.ts` with:
- `type ThemePreference = "light" | "dark" | "system"`
- `type ResolvedTheme = "light" | "dark"`
- pure helpers like `resolveThemePreference`, `getStoredThemePreference`, `setStoredThemePreference`, `createThemeBootScript`
- one shared storage key, e.g. `study-ui-theme`

**Step 4: Add provider and boot script wiring**

Implement `src/components/theme/theme-provider.tsx` with:
- `ThemeProvider`
- `useTheme()` hook
- `matchMedia("(prefers-color-scheme: dark)")` subscription
- `document.documentElement.dataset.theme = resolvedTheme`
- `document.documentElement.style.colorScheme = resolvedTheme`

Wire it into:
- `index.html` with pre-hydration inline script from `createThemeBootScript()`
- `src/main.tsx` by wrapping `<App />`

**Step 5: Run test to verify it passes**

Run: `node --test src/lib/theme.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add index.html package.json src/main.tsx src/lib/theme.ts src/lib/theme.test.ts src/components/theme/theme-provider.tsx
git commit -m "feat: add theme infrastructure"
```

## Task 2: Replace Kumo tokens with local semantic DS tokens

**Files:**
- Modify: `src/styles/app.css`
- Modify: `src/lib/utils.ts`
- Optionally modify: `package.json`

**Step 1: Add the failing verification check**

Create a lightweight assertion script or test that verifies:
- `src/styles/app.css` defines both light and dark semantic tokens
- no content component depends on Kumo token names after migration starts

Suggested test file: `scripts/ds-token-contract.test.mjs`

**Step 2: Run test to verify it fails**

Run: `node --test scripts/ds-token-contract.test.mjs`
Expected: FAIL because tokens and checks are not in place yet.

**Step 3: Introduce DS token system**

Refactor `src/styles/app.css` to:
- remove Kumo stylesheet import and `@source`
- define semantic tokens on `:root` and `[data-theme="dark"]`
- expose them with Tailwind v4 `@theme inline`
- include tokens for background, foreground, muted, border, accent, ring, card, input, overlay

Also upgrade `src/lib/utils.ts` to a shadcn-style `cn()` using `clsx` + `tailwind-merge`.

**Step 4: Run test to verify it passes**

Run: `node --test scripts/ds-token-contract.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json src/styles/app.css src/lib/utils.ts scripts/ds-token-contract.test.mjs
git commit -m "refactor: add local design tokens"
```

## Task 3: Rebuild `Button` and `Card/Surface` as DS wrappers

**Files:**
- Modify: `src/components/ui/button.tsx`
- Create: `src/components/ui/card.tsx`
- Modify: `src/components/ui/surface.tsx`
- Modify: `src/components/content/SettingsNav.tsx`
- Modify: `src/components/content/SettingsPanel.tsx`
- Modify: `src/components/content/ThreadCanvas.tsx`

**Step 1: Add a failing structure test**

Add a node-based source test that checks:
- `button.tsx` no longer imports from `@cloudflare/kumo`
- `surface.tsx` no longer imports from `@cloudflare/kumo`
- `card.tsx` exists

Suggested file: `scripts/ds-primitives-contract.test.mjs`

**Step 2: Run test to verify it fails**

Run: `node --test scripts/ds-primitives-contract.test.mjs`
Expected: FAIL

**Step 3: Implement the primitives**

- `button.tsx`: shadcn-style wrapper using `Slot` + `cva`
- `card.tsx`: local structural card pieces (`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`)
- `surface.tsx`: thin DS wrapper over a semantic container, likely implemented using `Card` styles rather than Kumo

**Step 4: Migrate current content panels**

Update content components to use the new DS `Button` and `Card/Surface` tokens instead of Kumo APIs like `icon`, `variant`, `Surface as="section"`, etc.

**Step 5: Run test to verify it passes**

Run: `node --test scripts/ds-primitives-contract.test.mjs`
Expected: PASS

**Step 6: Commit**

```bash
git add src/components/ui/button.tsx src/components/ui/card.tsx src/components/ui/surface.tsx src/components/content/SettingsNav.tsx src/components/content/SettingsPanel.tsx src/components/content/ThreadCanvas.tsx scripts/ds-primitives-contract.test.mjs
git commit -m "feat: add ds button and card primitives"
```

## Task 4: Rebuild `Input` and `Switch`

**Files:**
- Create: `src/components/ui/input.tsx`
- Modify: `src/components/ui/switch.tsx`
- Optionally create: `src/components/ui/label.tsx`
- Modify: `src/components/content/SettingsPanel.tsx`

**Step 1: Add the failing source contract test**

Extend `scripts/ds-primitives-contract.test.mjs` to require:
- `input.tsx` exists
- `switch.tsx` imports from `@radix-ui/react-switch`
- `switch.tsx` does not import from Kumo

**Step 2: Run test to verify it fails**

Run: `node --test scripts/ds-primitives-contract.test.mjs`
Expected: FAIL

**Step 3: Implement**

- `input.tsx`: DS input using tokens and focus states
- `switch.tsx`: Radix `Switch.Root` + `Switch.Thumb`, shadcn-style class API, dark/light token support
- Optionally add `Label` if it simplifies field composition

**Step 4: Apply the primitive in settings content**

Update `SettingsPanel` to use the DS switch and add at least one real DS input so the primitive is exercised in the current UI.

**Step 5: Run test to verify it passes**

Run: `node --test scripts/ds-primitives-contract.test.mjs`
Expected: PASS

**Step 6: Commit**

```bash
git add src/components/ui/input.tsx src/components/ui/switch.tsx src/components/ui/label.tsx src/components/content/SettingsPanel.tsx scripts/ds-primitives-contract.test.mjs
git commit -m "feat: add ds input and switch"
```

## Task 5: Add `Dialog` and `Tabs`

**Files:**
- Create: `src/components/ui/dialog.tsx`
- Create: `src/components/ui/tabs.tsx`
- Modify: `src/components/content/SettingsPanel.tsx`
- Optionally modify: `src/components/content/ThreadCanvas.tsx`

**Step 1: Add the failing contract test**

Extend `scripts/ds-primitives-contract.test.mjs` to require:
- `dialog.tsx` imports `@radix-ui/react-dialog`
- `tabs.tsx` imports `@radix-ui/react-tabs`

**Step 2: Run test to verify it fails**

Run: `node --test scripts/ds-primitives-contract.test.mjs`
Expected: FAIL

**Step 3: Implement the DS wrappers**

- `dialog.tsx`: shadcn-style compound exports (`Dialog`, `DialogTrigger`, `DialogContent`, etc.)
- `tabs.tsx`: local wrapper for `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`

**Step 4: Use them in current screens**

- Add one settings section that uses `Tabs`
- Add one current, visible action that opens a `Dialog` so the primitive is exercised in app runtime

**Step 5: Run test to verify it passes**

Run: `node --test scripts/ds-primitives-contract.test.mjs`
Expected: PASS

**Step 6: Commit**

```bash
git add src/components/ui/dialog.tsx src/components/ui/tabs.tsx src/components/content/SettingsPanel.tsx src/components/content/ThreadCanvas.tsx scripts/ds-primitives-contract.test.mjs
 git commit -m "feat: add ds dialog and tabs"
```

## Task 6: Remove Kumo dependence from current runtime path

**Files:**
- Modify: `package.json`
- Modify: `src/styles/app.css`
- Modify: current UI wrappers if needed

**Step 1: Add a failing dependency contract test**

Add a script test that fails if runtime UI wrappers or styles still depend on Kumo imports.

Suggested file: `scripts/no-kumo-runtime.test.mjs`

**Step 2: Run test to verify it fails**

Run: `node --test scripts/no-kumo-runtime.test.mjs`
Expected: FAIL

**Step 3: Remove current runtime dependency paths**

- remove `@cloudflare/kumo` imports from `src/components/ui/*`
- remove Kumo stylesheet imports from `src/styles/app.css`
- if fully unused, remove `@cloudflare/kumo` and `kumo-ui` from `package.json`

**Step 4: Run test to verify it passes**

Run: `node --test scripts/no-kumo-runtime.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json src/styles/app.css src/components/ui scripts/no-kumo-runtime.test.mjs
git commit -m "refactor: remove kumo runtime path"
```

## Task 7: Final verification

**Files:**
- Modify only if verification reveals regressions

**Step 1: Verify theme logic**

Run: `node --test src/lib/theme.test.ts`
Expected: PASS

**Step 2: Verify DS contract checks**

Run: `node --test scripts/ds-token-contract.test.mjs scripts/ds-primitives-contract.test.mjs scripts/no-kumo-runtime.test.mjs`
Expected: PASS

**Step 3: Verify shell invariants**

Run: `npm run test:shell`
Expected: PASS

**Step 4: Verify linter**

Run: `npm run lint`
Expected: PASS

**Step 5: Verify runtime**

Run: `npm run dev`
Then manually verify:
- app mode and settings mode both render
- light theme and dark theme both render
- system theme follows OS preference
- explicit override persists across reload
- shell controls remain custom and usable

**Step 6: Commit verification fixes if needed**

```bash
git add .
git commit -m "chore: finish radix ds migration"
```
