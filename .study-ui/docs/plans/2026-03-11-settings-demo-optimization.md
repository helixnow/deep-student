# Settings Demo Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Optimize the Settings Demo page so it is lighter to maintain, closer to real app behavior, and safer for repeated regression checks.

**Architecture:** Keep `src/components/content/SettingsDemoPanel.tsx` as the feature entry, but split it into data-driven presentational sections plus isolated interactive previews. Reuse shared app fixtures for sidebar/demo wiring where practical, and move ephemeral behavior like toast timing into a dedicated preview component with explicit cleanup.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS v4, node:test

---

### Task 1: Lock current Demo behavior with focused source tests

**Files:**
- Modify: `src/components/content/SettingsDemoPanel.source.test.ts`
- Modify: `src/App.demo.source.test.ts`
- Modify: `src/lib/settings-panel.test.ts`

**Step 1: Write the failing test**
- Add assertions that the Demo page remains reachable from the `demo` tab wiring.
- Add assertions that the Demo source is split into dedicated section/preview helpers instead of one fully inlined block.
- Add assertions that toast preview logic includes cleanup behavior and that sidebar preview uses shared data rather than hard-coded duplicates.

**Step 2: Run test to verify it fails**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts src/App.demo.source.test.ts src/lib/settings-panel.test.ts`
Expected: FAIL because the current Demo panel is still monolithic and duplicates preview data.

**Step 3: Write minimal implementation**
- Update the source tests only enough to describe the desired optimized structure.

**Step 4: Run test to verify it passes later**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts src/App.demo.source.test.ts src/lib/settings-panel.test.ts`
Expected: PASS after Tasks 2-4 are complete.

### Task 2: Split the monolithic Demo panel into stable sections

**Files:**
- Modify: `src/components/content/SettingsDemoPanel.tsx`
- Create: `src/components/content/settings-demo-data.tsx`
- Create: `src/components/content/settings-demo-sections.tsx`

**Step 1: Write the failing test**
- Extend `src/components/content/SettingsDemoPanel.source.test.ts` so it expects section data/config to live outside the main component and expects dedicated preview components for interactive areas.

**Step 2: Run test to verify it fails**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
Expected: FAIL because `SettingsDemoPanel` currently contains almost all demo markup inline.

**Step 3: Write minimal implementation**
- Move static labels, descriptions, and repeated demo content into `src/components/content/settings-demo-data.tsx`.
- Extract presentational section blocks into `src/components/content/settings-demo-sections.tsx`.
- Keep `SettingsDemoPanel` focused on page composition, not hundreds of lines of inline demo JSX.

**Step 4: Run test to verify it passes**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
Expected: PASS.

### Task 3: Isolate interactive previews and fix lifecycle safety

**Files:**
- Modify: `src/components/content/SettingsDemoPanel.tsx`
- Create: `src/components/content/settings-demo-interactions.tsx`

**Step 1: Write the failing test**
- Add a source assertion that toast logic is owned by a dedicated preview component and includes timeout cleanup on unmount.

**Step 2: Run test to verify it fails**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
Expected: FAIL because the current `toastVisible` state and timer live at the top of `SettingsDemoPanel` without cleanup.

**Step 3: Write minimal implementation**
- Extract Toast, Dialog, Sheet, Dropdown, Tabs, and Tooltip demos into focused preview components where local state is isolated.
- Add `useEffect` cleanup for the toast timer.
- Change the toast preview from viewport-fixed placement to a panel-scoped preview container unless the product intentionally wants to validate global app toasts.

**Step 4: Run test to verify it passes**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
Expected: PASS.

### Task 4: Remove preview drift by reusing real app-facing fixtures

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/content/SettingsDemoPanel.tsx`
- Create: `src/lib/demo-fixtures.tsx`

**Step 1: Write the failing test**
- Add source assertions that sidebar preview items and thread preview fixtures are imported from a shared file instead of duplicated inline literals.

**Step 2: Run test to verify it fails**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts src/App.demo.source.test.ts`
Expected: FAIL because Demo sidebar fixtures are currently embedded inside `SettingsDemoPanel.tsx`.

**Step 3: Write minimal implementation**
- Extract shared preview fixtures into `src/lib/demo-fixtures.tsx`.
- Reuse the real settings tab labels where possible, or derive a demo-safe subset from the same source structure used by `src/App.tsx`.
- Remove clipped-only validation by allowing the sidebar preview to scroll inside a bounded container rather than hard-cutting overflow.

**Step 4: Run test to verify it passes**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts src/App.demo.source.test.ts`
Expected: PASS.

### Task 5: Raise Demo fidelity for real regression use

**Files:**
- Modify: `src/components/content/SettingsDemoPanel.tsx`
- Modify: `src/components/ui/*` (only if shared primitive gaps must be filled)

**Step 1: Write the failing test**
- Add source assertions that the page clearly distinguishes shared primitives from mock-only patterns.

**Step 2: Run test to verify it fails**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
Expected: FAIL if the page still presents one-off controls as if they are shared component primitives.

**Step 3: Write minimal implementation**
- Replace the raw `<select>` demo with a shared primitive if one exists or is introduced.
- If a shared primitive is out of scope, relabel the section from “Select / Combobox” to make clear which parts are real primitives and which parts are visual mocks.
- Keep the Demo page aligned with the project’s actual reusable UI inventory.

**Step 4: Run test to verify it passes**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
Expected: PASS.

### Task 6: Full verification

**Files:**
- Modify as needed based on verification output

**Step 1: Run targeted tests**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts src/App.demo.source.test.ts src/lib/settings-panel.test.ts`
Expected: PASS.

**Step 2: Run lint**
Run: `npm run lint`
Expected: exit 0.

**Step 3: Run build**
Run: `npm run build`
Expected: exit 0.
